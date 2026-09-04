// ENG-85 (TT-03) — Punto de entrada del job semanal de verificación de integridad.
//
// Lo dispara `.github/workflows/integrity-check.yml` todos los lunes, y se puede
// correr a mano contra cualquier base:
//
//   node --env-file=.env --import tsx scripts/verify-integrity.ts
//
// Vive en `scripts/` y corre con tsx, igual que `verify:rls` y `db:seed`: no
// entra al build de producción (ver tsconfig.build.json), pero sus tipos sí se
// validan con `pnpm run typecheck`.
//
// No levanta el AppModule a propósito. Un job de cron no necesita el servidor
// HTTP, ni Supabase, ni el throttler, y arrastrarlos significaría exigirle
// `SUPABASE_URL`/`SUPABASE_ANON_KEY` al workflow para algo que solo habla con
// Postgres. Se arman las dos piezas a mano y listo.
//
// Códigos de salida:
//   0 — la cadena de todos los pacientes verificó bien.
//   1 — se detectaron inconsistencias, o la corrida no pudo terminar.
//
// Los dos casos salen con 1 a propósito: para el equipo, "hay manipulación" y
// "no sabemos si hay manipulación" requieren la misma reacción — ir a mirar.

import { PrismaService } from '../src/prisma/prisma.service';
import { SlackIntegrityAlerter } from '../src/integrity/integrity-alerter';
import { IntegrityService } from '../src/integrity/integrity.service';
import type { IntegrityRunResult } from '../src/integrity/integrity.types';
import { appendFileSync } from 'node:fs';

/** Link a la corrida de Actions, para que la alerta de Slack sea accionable. */
function githubRunUrl(): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/**
 * Resumen en la pestaña del run de Actions. Es también el registro más barato
 * fuera de la base de que la verificación corrió y con qué resultado: si alguien
 * manipula `integrity_checks`, el historial de runs de GitHub sigue ahí.
 */
function writeStepSummary(markdown: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  appendFileSync(path, `${markdown}\n`);
}

function summarize(result: IntegrityRunResult): string {
  const header = [
    '## ENG-85 · Integridad de la cadena de hash',
    '',
    `| | |`,
    `|---|---|`,
    `| Estado | **${result.status}** |`,
    `| Pacientes verificados | ${result.patientsChecked} |`,
    `| Entradas verificadas | ${result.entriesChecked} |`,
    `| Duración | ${result.durationMs} ms |`,
    `| Inconsistencias | ${result.failures.length} |`,
    `| \`integrity_checks.id\` | \`${result.checkId}\` |`,
  ];

  // El ancla (ENG-123). Este resumen es una de las dos copias que viven fuera de
  // Supabase: si alguien manipula `integrity_checks`, el historial de corridas de
  // GitHub sigue teniendo la raíz de cada semana. Por eso va completa y en
  // bloque de código, para poder copiarla y compararla.
  // `null` para lo condicional y `''` para los saltos de línea deliberados: en
  // Markdown la línea en blanco antes de un bloque de código o de una cita es
  // parte de la sintaxis, así que filtrar por `''` rompería el renderizado.
  const anchor: string[] = result.anchor
    ? (
        [
          '',
          '### Ancla de integridad',
          '',
          `Pacientes anclados: ${result.anchor.patients} · Entradas: ${result.anchor.entries}`,
          '',
          '```',
          result.anchor.root,
          '```',
          result.anchorRegression ? '' : null,
          result.anchorRegression
            ? '> ⚠️ **La raíz cambió sin que la Historia Clínica haya crecido.** Las verificaciones por paciente dieron OK, así que apunta a una manipulación que también tocó la base de comparación.'
            : null,
        ] as (string | null)[]
      ).filter((line): line is string => line !== null)
    : [];

  if (result.failures.length === 0) return [...header, ...anchor].join('\n');

  return [
    ...header,
    ...anchor,
    '',
    '### Inconsistencias',
    '',
    '| Paciente | seq | Motivo |',
    '|---|---|---|',
    ...result.failures
      .slice(0, 50)
      .map((f) => `| \`${f.patientId}\` | ${f.sequenceNumber} | ${f.reason} |`),
  ].join('\n');
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error('❌ Falta DATABASE_URL');
    return 1;
  }

  const alerter = new SlackIntegrityAlerter(
    process.env.SLACK_WEBHOOK_URL,
    githubRunUrl(),
  );
  const prisma = new PrismaService();

  try {
    const result = await new IntegrityService(prisma, alerter).run();
    writeStepSummary(summarize(result));

    if (result.status === 'OK') {
      console.log(
        `✅ Integridad OK — ${result.patientsChecked} paciente(s), ${result.entriesChecked} entrada(s), ${result.durationMs} ms`,
      );
      if (result.anchor) console.log(`🔒 Raíz: ${result.anchor.root}`);

      // Una regresión del ancla sale con 1 aunque las verificaciones por
      // paciente hayan dado OK: es exactamente el caso en el que la base ya no
      // es confiable como fuente, así que no puede reportarse como corrida sana.
      if (result.anchorRegression) {
        console.error(
          '🚨 La raíz del ancla cambió sin que la HC haya crecido. Ver docs/security/integrity-check-runbook.md',
        );
        return 1;
      }

      return 0;
    }

    console.error(
      `🚨 ${result.failures.length} inconsistencia(s). Detalle en integrity_checks (${result.checkId}).`,
    );
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ La verificación no pudo terminar: ${message}`);

    // Registrar el fallo es best-effort: si lo que se cayó es la base, este
    // insert también se cae. La alerta de Slack no depende de Postgres y es la
    // que garantiza que el equipo se entere igual.
    try {
      await prisma.integrityCheck.create({
        data: {
          status: 'ERROR',
          inconsistencies_found: 0,
          details: { error: message },
        },
      });
    } catch {
      console.error(
        '❌ Tampoco se pudo registrar el fallo en integrity_checks.',
      );
    }

    await alerter.runFailed(error);
    writeStepSummary(
      `## ENG-85 · Integridad de la cadena de hash\n\n❌ La verificación **no pudo correr**: \`${message}\``,
    );
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
