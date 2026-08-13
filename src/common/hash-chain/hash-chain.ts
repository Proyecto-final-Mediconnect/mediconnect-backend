/**
 * ENG-45 — Prototipo de cadena de hash SHA-256 para la Historia Clínica (EP-06).
 *
 * Cada entrada de HC encadena su hash con el de la anterior del mismo paciente:
 * alterar una entrada vieja invalida todas las que le siguen. Es el mecanismo que
 * sostiene el requisito de inalterabilidad de la Ley 26.529 (ADR-014/015).
 *
 * Este módulo es DELIBERADAMENTE puro: no depende de Nest ni de Prisma, no se
 * registra en AppModule y no toca `clinical_record_entries`. Es el entregable del
 * spike; ENG-57 lo promueve a módulo real cuando el diseño esté validado.
 *
 * Decisión de diseño: el hash se calcula en la APLICACIÓN, no en un trigger de
 * Postgres. La base solo verifica el encadenamiento (ver
 * prisma/spikes/eng45_hash_chain.sql). El porqué y el límite de esa decisión
 * están en mediconnect-docs/documentacion-tecnica/spikes/ENG-45-hash-chain.md.
 */
import { createHash } from 'node:crypto';

/** `previous_hash` de la primera entrada de cada paciente (64 ceros). */
export const GENESIS_HASH = '0'.repeat(64);

/** Campos que entran al hash. Todo lo que no esté acá NO está protegido. */
export interface ChainEntryInput {
  patientId: string;
  sequenceNumber: number;
  entryType: string;
  fhirResourceType: string;
  /** Recurso FHIR R5. Solo datos sintéticos en tests. */
  content: unknown;
  /** Entrada que esta corrige, si es una corrección. */
  correctsEntryId?: string | null;
  /**
   * Lo genera la aplicación, NO la base. Ver la nota sobre precisión en el
   * informe del spike: `timestamptz(6)` no sobrevive el round-trip por
   * `Date` de JavaScript y rompe la verificación.
   */
  createdAt: Date;
}

export interface ChainEntry extends ChainEntryInput {
  contentHash: string;
  previousHash: string;
}

export type ChainFailureReason =
  | 'GENESIS_MISMATCH'
  | 'SEQUENCE_GAP'
  | 'BROKEN_LINK'
  | 'CONTENT_TAMPERED';

export interface ChainFailure {
  sequenceNumber: number;
  reason: ChainFailureReason;
  expected: string;
  found: string;
}

export type ChainVerification =
  | { valid: true; entries: number; headHash: string }
  | { valid: false; entries: number; failure: ChainFailure };

/**
 * Serialización canónica (JCS, RFC 8785 acotado a lo que usamos): claves de
 * objeto ordenadas por code unit UTF-16, sin espacios, `undefined` descartado.
 *
 * Hace falta porque `JSON.stringify` preserva el orden de inserción: el mismo
 * recurso FHIR llegando por dos caminos distintos produciría dos hashes
 * distintos y la cadena se rompería sin que nadie la haya manipulado.
 *
 * No se usa `jsonb::text` de Postgres como forma canónica a propósito: jsonb
 * ordena las claves por (longitud, bytes), un orden distinto al de RFC 8785, y
 * atarnos a él nos amarraría a Postgres para siempre.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `hash-chain: número no serializable en content: ${value}`,
      );
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (typeof value === 'object') {
    const pairs = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${pairs.join(',')}}`;
  }

  throw new Error(
    `hash-chain: tipo no serializable en content: ${typeof value}`,
  );
}

/**
 * Texto exacto sobre el que se calcula el SHA-256.
 *
 * El separador es `\n` y es seguro: el único campo de forma libre es `content`,
 * y al pasar por `canonicalJson` cualquier salto de línea real queda escapado
 * como los dos caracteres `\` + `n`. Ningún campo puede inyectar un separador.
 */
export function buildPreimage(
  entry: ChainEntryInput,
  previousHash: string,
): string {
  return [
    entry.patientId,
    String(entry.sequenceNumber),
    entry.entryType,
    entry.fhirResourceType,
    canonicalJson(entry.content),
    entry.correctsEntryId ?? '',
    entry.createdAt.toISOString(),
    previousHash,
  ].join('\n');
}

export function computeContentHash(
  entry: ChainEntryInput,
  previousHash: string,
): string {
  return createHash('sha256')
    .update(buildPreimage(entry, previousHash), 'utf8')
    .digest('hex');
}

/** Sella una entrada nueva contra la cabeza actual de la cadena del paciente. */
export function appendEntry(
  entry: ChainEntryInput,
  previousHash: string,
): ChainEntry {
  return {
    ...entry,
    previousHash,
    contentHash: computeContentHash(entry, previousHash),
  };
}

/**
 * Recorre la cadena recalculando cada hash. Detecta contenido alterado, enlaces
 * rotos, huecos de secuencia y entradas eliminadas del medio.
 *
 * Se corta en la primera falla: en una cadena rota todo lo posterior es ruido
 * derivado, y el dato que importa para auditar es DÓNDE se rompió.
 *
 * `entries` tiene que venir ordenado por `sequenceNumber` ascendente.
 */
export function verifyChain(entries: ChainEntry[]): ChainVerification {
  let previousHash = GENESIS_HASH;
  let previousSequence = 0;

  for (const entry of entries) {
    if (entry.previousHash !== previousHash) {
      return {
        valid: false,
        entries: entries.length,
        failure: {
          sequenceNumber: entry.sequenceNumber,
          reason: previousSequence === 0 ? 'GENESIS_MISMATCH' : 'BROKEN_LINK',
          expected: previousHash,
          found: entry.previousHash,
        },
      };
    }

    if (entry.sequenceNumber !== previousSequence + 1) {
      return {
        valid: false,
        entries: entries.length,
        failure: {
          sequenceNumber: entry.sequenceNumber,
          reason: 'SEQUENCE_GAP',
          expected: String(previousSequence + 1),
          found: String(entry.sequenceNumber),
        },
      };
    }

    const recomputed = computeContentHash(entry, entry.previousHash);
    if (recomputed !== entry.contentHash) {
      return {
        valid: false,
        entries: entries.length,
        failure: {
          sequenceNumber: entry.sequenceNumber,
          reason: 'CONTENT_TAMPERED',
          expected: recomputed,
          found: entry.contentHash,
        },
      };
    }

    previousHash = entry.contentHash;
    previousSequence = entry.sequenceNumber;
  }

  return { valid: true, entries: entries.length, headHash: previousHash };
}
