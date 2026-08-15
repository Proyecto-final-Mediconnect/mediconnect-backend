/**
 * ENG-85 — Auditoría de la cadena de hash de un paciente.
 *
 * Es la capa que envuelve a `verifyChain` (ENG-45) con lo que esa función, por
 * diseño, no puede saber: **cuánto medía la cadena la última vez que la vimos**.
 *
 * `verifyChain` mira una cadena aislada y responde si es internamente coherente.
 * Eso deja dos ataques afuera, los dos documentados en el spike ENG-45:
 *
 *   1. **Truncar la cola.** Borrar las últimas N entradas deja el resto contiguo,
 *      enlazado y arrancando en el génesis. `verifyChain` devuelve `valid: true`.
 *      Es el caso clínicamente más plausible: para ocultar un diagnóstico
 *      reciente es más simple borrarlo que falsificarlo.
 *   2. **Reescribir la historia hacia adelante.** Cambiar una entrada vieja y
 *      recalcular todos los hashes posteriores produce una cadena nueva,
 *      perfectamente coherente consigo misma.
 *
 * Los dos se detectan con lo mismo: el hash de cabeza que dejó registrado la
 * corrida anterior (`chain_head_snapshots`). Este módulo es puro —no toca Prisma,
 * no sabe de Nest— para que las dos detecciones se puedan probar en memoria.
 */
import {
  verifyChain,
  type ChainEntry,
  type ChainFailureReason,
} from '../common/hash-chain/hash-chain';

/**
 * Motivos de ENG-85 = los de `verifyChain` + los dos que solo se ven comparando
 * contra la corrida anterior.
 */
export type IntegrityFailureReason =
  | ChainFailureReason
  | 'TAIL_TRUNCATED'
  | 'HISTORY_REWRITTEN';

/** Cabeza de la cadena de un paciente al cierre de una corrida sana. */
export interface ChainHead {
  headHash: string;
  sequenceNumber: number;
}

/**
 * Inconsistencia concreta. Todo lo que va acá termina en `integrity_checks.details`
 * y en la alerta de Slack, así que **no puede contener datos clínicos**: solo el
 * UUID del paciente, la posición en la cadena y hashes.
 */
export interface IntegrityFailure {
  patientId: string;
  sequenceNumber: number;
  reason: IntegrityFailureReason;
  expected: string;
  found: string;
}

export type PatientChainAudit =
  | { patientId: string; ok: true; entries: number; head: ChainHead | null }
  | {
      patientId: string;
      ok: false;
      entries: number;
      failure: IntegrityFailure;
    };

/**
 * Audita la cadena completa de un paciente contra la cabeza de la corrida
 * anterior.
 *
 * `entries` tiene que venir ordenado por `sequenceNumber` ascendente.
 * `snapshot` es `null` en la primera corrida de ese paciente: ahí no hay contra
 * qué comparar y solo se valida la coherencia interna. Es la razón por la que el
 * snapshot tiene que empezar a escribirse desde la primera corrida del job y no
 * cuando ya haya historia acumulada.
 */
export function auditPatientChain(
  patientId: string,
  entries: ChainEntry[],
  snapshot: ChainHead | null,
): PatientChainAudit {
  const verification = verifyChain(entries);

  if (!verification.valid) {
    return {
      patientId,
      ok: false,
      entries: verification.entries,
      failure: { patientId, ...verification.failure },
    };
  }

  // Con la cadena ya validada, la secuencia arranca en 1 y es contigua: la
  // cabeza es la última entrada y su `sequenceNumber` es también la cantidad.
  const currentSequence =
    entries.length === 0 ? 0 : entries[entries.length - 1].sequenceNumber;

  if (snapshot && snapshot.sequenceNumber > 0) {
    // (1) Truncado de cola. Incluye el borrado total (`currentSequence === 0`).
    if (currentSequence < snapshot.sequenceNumber) {
      return {
        patientId,
        ok: false,
        entries: verification.entries,
        failure: {
          patientId,
          sequenceNumber: currentSequence,
          reason: 'TAIL_TRUNCATED',
          expected: `sequence_number >= ${snapshot.sequenceNumber}`,
          found: `sequence_number = ${currentSequence}`,
        },
      };
    }

    // (2) Reescritura de la historia. La entrada que era cabeza sigue estando
    // —la cadena no se acortó— pero ya no tiene el mismo hash, así que algo por
    // debajo de ella cambió y se volvió a sellar todo hacia adelante.
    //
    // El índice es seguro: la secuencia es contigua desde 1 y acabamos de
    // descartar que `currentSequence` sea menor.
    const previousHead = entries[snapshot.sequenceNumber - 1];
    if (previousHead.contentHash !== snapshot.headHash) {
      return {
        patientId,
        ok: false,
        entries: verification.entries,
        failure: {
          patientId,
          sequenceNumber: snapshot.sequenceNumber,
          reason: 'HISTORY_REWRITTEN',
          expected: snapshot.headHash,
          found: previousHead.contentHash,
        },
      };
    }
  }

  return {
    patientId,
    ok: true,
    entries: verification.entries,
    head:
      currentSequence === 0
        ? null
        : { headHash: verification.headHash, sequenceNumber: currentSequence },
  };
}
