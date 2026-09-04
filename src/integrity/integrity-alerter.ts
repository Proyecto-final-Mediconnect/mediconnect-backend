/**
 * ENG-85 — Alerta a Slack del job de verificación de integridad.
 *
 * Qué puede salir del backend hacia Slack, que es un canal con retención,
 * exportable y de membresía más amplia que la base:
 *
 *   - SÍ: `patient_id` (UUID opaco), `sequence_number`, el motivo, los hashes y
 *     los contadores de la corrida. Es el mínimo para que alguien pueda ir a
 *     investigar, y sin acceso a la base un UUID no identifica a nadie.
 *   - NO: `content` ni nada derivado de él, nombres, DNI, emails, ni el
 *     `professional_id` firmante. Ninguno hace falta para actuar sobre la alerta
 *     y todos son datos de salud o PII.
 *
 * Sin `SLACK_WEBHOOK_URL` el alertador queda inactivo y lo dice en el log: es el
 * comportamiento esperado en local y en CI, donde no hay a quién avisarle.
 */
import { Logger } from '@nestjs/common';
import type { IntegrityRunResult } from './integrity.types';

/** Cuántas inconsistencias se listan en el mensaje antes de cortar. */
const MAX_FAILURES_IN_MESSAGE = 10;

/** Un webhook colgado no puede dejar al job esperando en el runner. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface IntegrityAlerter {
  /** @returns `true` si la alerta se entregó. */
  inconsistencyDetected(result: IntegrityRunResult): Promise<boolean>;
  /** La corrida no pudo terminar. Un watchdog que falla en silencio no sirve. */
  runFailed(error: unknown): Promise<boolean>;
  /**
   * Publica el ancla de una corrida sana (ENG-123).
   *
   * A diferencia de las otras dos, este mensaje sale aunque no pase nada — es el
   * punto: lo que protege es la **serie publicada** de raíces, fuera de la base.
   * Un ancla que solo aparece cuando hay problemas no ancla nada.
   */
  anchorPublished(result: IntegrityRunResult): Promise<boolean>;
}

export class SlackIntegrityAlerter implements IntegrityAlerter {
  private readonly logger = new Logger(SlackIntegrityAlerter.name);

  /**
   * @param webhookUrl Incoming Webhook del canal del equipo. Es un secreto: da
   *   permiso de publicar en el canal, así que no se loguea nunca —ni siquiera
   *   truncado— y viaja por `secrets.SLACK_WEBHOOK_URL` en el workflow.
   * @param runUrl Link a la corrida de GitHub Actions, si el job lo provee.
   */
  constructor(
    private readonly webhookUrl?: string,
    private readonly runUrl?: string,
  ) {}

  async inconsistencyDetected(result: IntegrityRunResult): Promise<boolean> {
    const shown = result.failures.slice(0, MAX_FAILURES_IN_MESSAGE);
    const omitted = result.failures.length - shown.length;

    const detail = shown
      .map(
        (f) =>
          `paciente ${f.patientId} · seq ${f.sequenceNumber} · ${f.reason}`,
      )
      .join('\n');

    const lines = [
      `*${result.failures.length}* inconsistencia(s) en la cadena de hash de la Historia Clínica.`,
      `Pacientes verificados: *${result.patientsChecked}* · Entradas: *${result.entriesChecked}* · Duración: *${result.durationMs} ms*`,
      '',
      '```',
      detail,
      omitted > 0 ? `… y ${omitted} más` : '',
      '```',
      `Detalle completo en \`integrity_checks\` (id \`${result.checkId}\`).`,
      this.runUrl ? `Corrida: ${this.runUrl}` : '',
    ].filter((line) => line !== '');

    return this.post(
      '🚨 Integridad de la Historia Clínica: inconsistencia detectada',
      lines.join('\n'),
    );
  }

  async anchorPublished(result: IntegrityRunResult): Promise<boolean> {
    const { anchor } = result;
    if (!anchor) return false;

    // La raíz va COMPLETA y en bloque de código: es el valor que alguien va a
    // comparar contra el de otra semana, así que tiene que poder copiarse tal
    // cual. Truncarla para que quede lindo la volvería inútil.
    // `null` para lo condicional: el `''` de arriba es un salto de línea
    // deliberado y filtrarlo pegaría el bloque de código al párrafo.
    const lines = [
      `Pacientes: *${anchor.patients}* · Entradas: *${anchor.entries}*`,
      '',
      'Raíz SHA-256 de las cabezas de cadena:',
      '```',
      anchor.root,
      '```',
      result.anchorRegression
        ? '⚠️ *La raíz cambió sin que la Historia Clínica haya crecido.* Las verificaciones por paciente dieron OK, así que esto apunta a una manipulación que también tocó la base de comparación. Ver el runbook.'
        : 'Guardá este mensaje: es la copia fuera de la base que permite detectar una reescritura completa.',
      this.runUrl ? `Corrida: ${this.runUrl}` : null,
    ].filter((line): line is string => line !== null);

    return this.post(
      result.anchorRegression
        ? '🚨 Ancla de integridad: la raíz se movió sin explicación'
        : '🔒 Ancla de integridad de la Historia Clínica',
      lines.join('\n'),
    );
  }

  async runFailed(error: unknown): Promise<boolean> {
    // Solo el mensaje, no el stack: un stack puede arrastrar la connection
    // string o fragmentos de query al canal.
    const reason = error instanceof Error ? error.message : String(error);

    return this.post(
      '⚠️ Integridad de la Historia Clínica: la verificación no pudo correr',
      [
        'El job semanal de ENG-85 falló antes de poder verificar la cadena.',
        `Motivo: \`${reason}\``,
        'La integridad de la HC **no quedó verificada** en esta corrida.',
        this.runUrl ? `Corrida: ${this.runUrl}` : '',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    );
  }

  private async post(title: string, body: string): Promise<boolean> {
    if (!this.webhookUrl) {
      this.logger.warn(
        `SLACK_WEBHOOK_URL no configurado: la alerta no se envía. ${title}`,
      );
      return false;
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // `text` es el fallback de la notificación push y del cliente que no
          // renderiza bloques; sin él Slack avisa "This content can't be
          // displayed".
          text: title,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: title, emoji: true },
            },
            { type: 'section', text: { type: 'mrkdwn', text: body } },
          ],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.error(
          `Slack rechazó la alerta (HTTP ${response.status}). La inconsistencia igual quedó registrada en integrity_checks.`,
        );
        return false;
      }

      return true;
    } catch (error) {
      // No se relanza a propósito: que Slack esté caído no puede tapar el
      // hallazgo ni abortar la corrida. El job igual sale con código distinto de
      // cero y el resultado ya está en la base.
      this.logger.error(
        `No se pudo enviar la alerta a Slack: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
