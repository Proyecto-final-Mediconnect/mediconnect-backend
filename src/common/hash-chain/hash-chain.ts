/**
 * Cadena de hash SHA-256 de la Historia Clínica (EP-06).
 *
 * Cada entrada de HC encadena su hash con el de la anterior del mismo paciente:
 * alterar una entrada vieja invalida todas las que le siguen. Es el mecanismo que
 * sostiene el requisito de inalterabilidad de la Ley 26.529 (ADR-014/015).
 *
 * Nació como el prototipo del spike **ENG-45** y quedó tal cual: el diseño se
 * validó contra Postgres real y no hizo falta reescribir nada. Hoy lo usan
 * `IntegrityService` (ENG-85, verificación semanal) y `ClinicalRecordsService`
 * (ENG-57, escritura de entradas) sobre la tabla real.
 *
 * Sigue siendo DELIBERADAMENTE puro: sin Nest, sin Prisma, sin I/O. Eso es lo que
 * permite testear los bordes del hash sin base y —más importante— lo que hace que
 * una entrada de HC se pueda verificar fuera de este backend, que es la premisa
 * del pasaporte médico portable.
 *
 * Decisión de diseño: el hash se calcula en la APLICACIÓN, no en un trigger de
 * Postgres. La base solo verifica el encadenamiento (ver la migración
 * `20260826120000_eng57_clinical_record_chain`). El porqué y el límite de esa
 * decisión están en
 * mediconnect-docs/documentacion-tecnica/spikes/ENG-45-hash-chain.md.
 */
import { createHash } from 'node:crypto';

/** `previous_hash` de la primera entrada de cada paciente (64 ceros). */
export const GENESIS_HASH = '0'.repeat(64);

/** Campos que entran al hash. Todo lo que no esté acá NO está protegido. */
export interface ChainEntryInput {
  patientId: string;
  /**
   * Autoría del asiento clínico. Entra al hash porque la Ley 26.529 art. 15
   * exige que el registro identifique al profesional actuante: si quedara
   * afuera se podría reasignar quién firmó una entrada sin romper la cadena,
   * que es más barato para un atacante que falsificar el contenido.
   */
  professionalId: string;
  sequenceNumber: number;
  entryType: string;
  fhirResourceType: string;
  /** Recurso FHIR R5. Solo datos sintéticos en tests. */
  content: unknown;
  /** Consulta que originó la entrada, si viene de una. */
  consultationId?: string | null;
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
 * Columnas de la tabla que ENTRAN a la preimagen, en el mismo orden.
 *
 * Es la lista congelada del diseño: cambiarla obliga a rehashear todo lo ya
 * escrito, y en una tabla append-only eso significa migrar la cadena entera.
 * El test `la preimagen cubre todas las columnas de la tabla` la compara contra
 * el esquema real y falla si aparece una columna nueva sin decidir qué hacer.
 */
export const PREIMAGE_COLUMNS = [
  'patient_id',
  'professional_id',
  'sequence_number',
  'entry_type',
  'fhir_resource_type',
  'content',
  'consultation_id',
  'corrects_entry_id',
  'created_at',
  'previous_hash',
] as const;

/**
 * Columnas que quedan afuera de la preimagen A PROPÓSITO.
 *
 * `id` lo genera la base y no aporta (la identidad de la entrada ya está dada
 * por `patient_id` + `sequence_number`); `content_hash` es el resultado, no
 * puede ser su propia entrada.
 */
export const NON_HASHED_COLUMNS = ['id', 'content_hash'] as const;

/**
 * Texto exacto sobre el que se calcula el SHA-256.
 *
 * El orden es el de `PREIMAGE_COLUMNS` y es parte del diseño: cambiarlo produce
 * hashes distintos sobre los mismos datos.
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
    entry.professionalId,
    String(entry.sequenceNumber),
    entry.entryType,
    entry.fhirResourceType,
    canonicalJson(entry.content),
    entry.consultationId ?? '',
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

/**
 * Fila de `clinical_record_entries` tal como sale de Prisma.
 *
 * `sequence_number` viaja como `bigint` por el tipo de la columna.
 */
export interface ChainEntryRow {
  patient_id: string;
  professional_id: string;
  sequence_number: bigint | number;
  entry_type: string;
  fhir_resource_type: string;
  content: unknown;
  consultation_id: string | null;
  corrects_entry_id: string | null;
  created_at: Date;
  content_hash: string;
  previous_hash: string;
}

/**
 * Convierte una fila de la base en la entrada que entiende la cadena.
 *
 * Vive acá y no en el módulo que la usa porque el mapeo es parte del contrato del
 * hash: si una columna se tradujera mal —o se olvidara— el hash recalculado no
 * coincidiría y la entrada saldría reportada como manipulada estando intacta. La
 * lista de campos tiene que seguir a `PREIMAGE_COLUMNS`.
 *
 * `sequence_number` se convierte a `number` porque es como se hasheó al sellar
 * (la preimagen lo serializa en decimal). Recién con `Number.MAX_SAFE_INTEGER`
 * entradas para un mismo paciente el problema sería otro.
 *
 * NOTA: `IntegrityService` (ENG-85) tiene hoy su propia copia privada de esta
 * función. Conviene que adopte esta y borre la suya, pero no se hace acá para no
 * tocar un archivo que ENG-123 tiene abierto en review.
 */
export function chainEntryFromRow(row: ChainEntryRow): ChainEntry {
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
