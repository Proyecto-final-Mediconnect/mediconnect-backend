/**
 * ENG-85 (TT-03) — Verificación periódica de integridad de la cadena de hash.
 *
 * Recorre la cadena de HC de **todos** los pacientes recalculando cada SHA-256,
 * la compara contra la cabeza que dejó la corrida anterior, registra el resultado
 * en `integrity_checks` y alerta a Slack si algo no cierra.
 *
 * Lo corre el workflow semanal `.github/workflows/integrity-check.yml` a través de
 * `scripts/verify-integrity.ts`. No se expone por HTTP: no hay endpoint que
 * dispare esto, así que no hay superficie que abusar.
 *
 * Sobre el costo: el spike ENG-45 midió 1.000 entradas leídas de la base en
 * ~42 ms de punta a punta (lectura + verificación), lineal. Se recorre todo sin
 * muestrear — muestrear en una verificación de integridad es dejarle al atacante
 * la mitad de la tabla.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ChainEntry } from '../common/hash-chain/hash-chain';
import {
  anchorRegressed,
  computeAnchor,
  type AnchoredHead,
  type ChainAnchor,
} from './chain-anchor';
import { auditPatientChain, type IntegrityFailure } from './chain-audit';
import type { IntegrityAlerter } from './integrity-alerter';
import type { IntegrityRunResult } from './integrity.types';

/**
 * Tope de inconsistencias que se serializan en `integrity_checks.details`.
 *
 * Una cadena rota temprano puede arrastrar miles de entradas y no tiene sentido
 * guardar una fila de megabytes: con las primeras alcanza para arrancar la
 * investigación, y el contador total va aparte en `inconsistencies_found`.
 */
const MAX_FAILURES_IN_DETAILS = 50;

/** Fila de `clinical_record_entries` con lo necesario para rehashear. */
interface EntryRow {
  patient_id: string;
  professional_id: string;
  sequence_number: bigint;
  entry_type: string;
  fhir_resource_type: string;
  content: unknown;
  consultation_id: string | null;
  corrects_entry_id: string | null;
  created_at: Date;
  content_hash: string;
  previous_hash: string;
}

@Injectable()
export class IntegrityService {
  private readonly logger = new Logger(IntegrityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerter: IntegrityAlerter,
  ) {}

  async run(): Promise<IntegrityRunResult> {
    const startedAt = Date.now();
    const patientIds = await this.patientsToVerify();

    const failures: IntegrityFailure[] = [];
    const heads: AnchoredHead[] = [];
    let entriesChecked = 0;

    for (const patientId of patientIds) {
      const [rows, snapshot] = await Promise.all([
        this.prisma.clinicalRecordEntry.findMany({
          where: { patient_id: patientId },
          orderBy: { sequence_number: 'asc' },
          select: {
            patient_id: true,
            professional_id: true,
            sequence_number: true,
            entry_type: true,
            fhir_resource_type: true,
            content: true,
            consultation_id: true,
            corrects_entry_id: true,
            created_at: true,
            content_hash: true,
            previous_hash: true,
          },
        }),
        this.prisma.chainHeadSnapshot.findUnique({
          where: { patient_id: patientId },
          select: { head_hash: true, sequence_number: true },
        }),
      ]);

      entriesChecked += rows.length;

      const audit = auditPatientChain(
        patientId,
        rows.map((row) => toChainEntry(row as EntryRow)),
        snapshot
          ? {
              headHash: snapshot.head_hash,
              sequenceNumber: Number(snapshot.sequence_number),
            }
          : null,
      );

      if (!audit.ok) {
        failures.push(audit.failure);
        // NO se actualiza el snapshot de una cadena que falló, y es el punto
        // más importante del job: si se guardara la cabeza actual, la corrida
        // siguiente tomaría la versión manipulada como línea de base y la
        // manipulación quedaría blanqueada. La cabeza vieja se conserva hasta
        // que alguien resuelva el incidente a mano.
        this.logger.error(
          `Cadena inconsistente · paciente ${patientId} · seq ${audit.failure.sequenceNumber} · ${audit.failure.reason}`,
        );
        continue;
      }

      if (audit.head) {
        await this.saveHead(patientId, audit.head);
        heads.push({ patientId, ...audit.head });
      }
    }

    const durationMs = Date.now() - startedAt;
    const status = failures.length === 0 ? 'OK' : 'INCONSISTENT';

    // El ancla solo se emite si TODA la corrida verificó. Publicar la raíz de un
    // conjunto que incluye una cadena manipulada la convertiría en la referencia
    // buena de la semana siguiente — el mismo blanqueo que se evita al no pisar
    // el snapshot.
    const anchor = status === 'OK' ? computeAnchor(heads) : null;
    const previousAnchor = anchor ? await this.lastPublishedAnchor() : null;
    const anchorRegression = anchor
      ? anchorRegressed(anchor, previousAnchor)
      : false;

    if (anchorRegression) {
      this.logger.error(
        `La raíz del ancla cambió sin que la HC creciera: ${previousAnchor?.root} -> ${anchor?.root}`,
      );
    }

    const check = await this.prisma.integrityCheck.create({
      data: {
        status,
        inconsistencies_found: failures.length,
        details: {
          patients_checked: patientIds.length,
          entries_checked: entriesChecked,
          duration_ms: durationMs,
          // Campo por campo, no `...f`: `details` es lo que queda escrito y lo
          // que después se consulta por SQL, así que conviene que agregar una
          // propiedad al tipo no la publique sola. Snake_case para que combine
          // con el resto de las columnas.
          failures: failures.slice(0, MAX_FAILURES_IN_DETAILS).map((f) => ({
            patient_id: f.patientId,
            sequence_number: f.sequenceNumber,
            reason: f.reason,
            expected: f.expected,
            found: f.found,
          })),
          failures_omitted: Math.max(
            0,
            failures.length - MAX_FAILURES_IN_DETAILS,
          ),
          // Copia interna del ancla. NO es el ancla: vive en la misma base que
          // protege y el atacante puede tocarla. Es lo que le permite a la
          // corrida siguiente comparar sola. Las copias que sostienen la
          // afirmación son las de Slack y el resumen de Actions.
          anchor: anchor
            ? {
                root: anchor.root,
                patients: anchor.patients,
                entries: anchor.entries,
              }
            : null,
          anchor_regression: anchorRegression,
        },
      },
      select: { id: true },
    });

    const result: IntegrityRunResult = {
      checkId: check.id,
      status,
      patientsChecked: patientIds.length,
      entriesChecked,
      durationMs,
      failures,
      anchor,
      anchorRegression,
    };

    if (status === 'INCONSISTENT') {
      await this.alerter.inconsistencyDetected(result);
    } else {
      this.logger.log(
        `Integridad OK · ${patientIds.length} paciente(s) · ${entriesChecked} entrada(s) · ${durationMs} ms · raíz ${anchor?.root.slice(0, 16)}…`,
      );
    }

    // El ancla se publica SIEMPRE que la corrida verificó, aunque no haya pasado
    // nada: un ancla que solo aparece cuando hay problemas no sirve como ancla,
    // porque justamente lo que se necesita es la serie histórica publicada.
    //
    // La excepción es la base todavía sin Historia Clínica: hasta que ENG-57
    // escriba la primera entrada, anclar el conjunto vacío sería un mensaje
    // semanal sin información.
    if (anchor && anchor.patients > 0) {
      await this.alerter.anchorPublished(result);
    }

    return result;
  }

  /**
   * Ancla de la última corrida que la publicó.
   *
   * Se busca la última fila `OK` con ancla y no simplemente la última fila: una
   * corrida `INCONSISTENT` o `ERROR` no publica ancla, y tomar su `null` como
   * referencia haría perder el punto de comparación justo cuando más se lo
   * necesita — después de un incidente.
   */
  private async lastPublishedAnchor(): Promise<ChainAnchor | null> {
    const rows = await this.prisma.integrityCheck.findMany({
      where: { status: 'OK' },
      orderBy: { run_at: 'desc' },
      take: 1,
      select: { details: true },
    });

    const anchor = (rows[0]?.details as { anchor?: ChainAnchor } | null)
      ?.anchor;

    return anchor ?? null;
  }

  /**
   * Pacientes con entradas de HC **más** los que tienen snapshot de una corrida
   * anterior.
   *
   * La unión no es cosmética: si a un paciente se le borran TODAS las entradas,
   * desaparece de `clinical_record_entries` y una verificación que recorriera
   * solo esa tabla no lo miraría nunca. El snapshot es lo que deja rastro de que
   * ese paciente tenía una cadena.
   */
  private async patientsToVerify(): Promise<string[]> {
    const [withEntries, withSnapshot] = await Promise.all([
      this.prisma.clinicalRecordEntry.groupBy({ by: ['patient_id'] }),
      this.prisma.chainHeadSnapshot.findMany({ select: { patient_id: true } }),
    ]);

    return [
      ...new Set([
        ...withEntries.map((row) => row.patient_id),
        ...withSnapshot.map((row) => row.patient_id),
      ]),
    ].sort();
  }

  private async saveHead(
    patientId: string,
    head: { headHash: string; sequenceNumber: number },
  ): Promise<void> {
    const now = new Date();

    await this.prisma.chainHeadSnapshot.upsert({
      where: { patient_id: patientId },
      create: {
        patient_id: patientId,
        head_hash: head.headHash,
        sequence_number: head.sequenceNumber,
        first_seen_at: now,
        updated_at: now,
      },
      update: {
        head_hash: head.headHash,
        sequence_number: head.sequenceNumber,
        updated_at: now,
      },
    });
  }
}

/**
 * Fila de Postgres → entrada de cadena.
 *
 * `sequence_number` viaja como `bigint` por el tipo de la columna, pero la
 * preimagen lo hashea como decimal y `verifyChain` lo compara como número: la
 * conversión tiene que dar exactamente lo que se hasheó al sellar. Con
 * `Number.MAX_SAFE_INTEGER` de entradas para un solo paciente el problema sería
 * otro.
 */
function toChainEntry(row: EntryRow): ChainEntry {
  return {
    patientId: row.patient_id,
    professionalId: row.professional_id,
    sequenceNumber: Number(row.sequence_number),
    entryType: row.entry_type,
    fhirResourceType: row.fhir_resource_type,
    content: row.content,
    consultationId: row.consultation_id,
    correctsEntryId: row.corrects_entry_id,
    createdAt: row.created_at,
    contentHash: row.content_hash,
    previousHash: row.previous_hash,
  };
}
