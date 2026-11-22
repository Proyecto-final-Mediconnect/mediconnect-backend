/**
 * ENG-216 — Cifrado de sobre de los datos clínicos (ADR-020, punto 8).
 *
 * Esta capa es pura: no sabe de Prisma ni de Nest, así que se prueba en memoria.
 * La que guarda y busca las claves de cada paciente es `ClinicalDataCipher`.
 *
 * El esquema, probado antes de implementarlo en el spike ENG-239:
 *
 * - Cada dato se cifra con **AES-256-GCM** usando la **clave de datos (DEK) del
 *   paciente**. GCM autentica: un byte cambiado hace fallar el descifrado.
 * - La DEK se guarda **envuelta** (cifrada) con una **clave maestra (KEK)**
 *   versionada por `kid`. La base nunca tiene una DEK en claro, y la KEK nunca
 *   toca la base: vive en la variable de entorno `DATA_ENCRYPTION_KEYS`.
 * - El lugar del dato (tabla, fila, campo y paciente) va como **AAD**: un valor
 *   copiado a otra fila, a otro campo o a otro paciente no se descifra.
 * - **Rotar la KEK** es re-envolver las DEK (`scripts/rotate-data-keys.ts`):
 *   los datos no se tocan, y por eso la HC, que es append-only, se puede rotar.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Versión del formato de un valor cifrado. `0` (sin marca) es texto en claro. */
export const ENCRYPTION_VERSION = 'v1';

/**
 * Marca de un JSON cifrado: `{ "$enc": "v1.<nonce>.<etiqueta>.<texto>" }`.
 *
 * Un recurso FHIR siempre tiene `resourceType` y nunca una clave que empiece con
 * `$`, así que la marca no puede confundirse con un contenido en claro.
 */
export const ENCRYPTED_JSON_KEY = '$enc';

/** Formato de `DATA_ENCRYPTION_KEYS`: `kid:clave` separados por coma. */
const KID_PATTERN = /^[a-z0-9-]{1,16}$/;

export interface Keyring {
  /** La KEK con la que se envuelven las DEK nuevas: la última de la lista. */
  activeKid: string;
  keys: ReadonlyMap<string, Buffer>;
}

/** El valor no se pudo descifrar: está alterado o no es de este lugar. */
export class DecryptionError extends Error {
  constructor(message = 'El dato cifrado no se pudo autenticar.') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Hay datos cifrados y el proceso no tiene la clave para leerlos. */
export class MissingKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingKeyError';
  }
}

/**
 * Lee `DATA_ENCRYPTION_KEYS`: `k1:<base64 de 32 bytes>[,k2:<...>]`.
 *
 * Devuelve `null` si no está definida: el backend sigue andando y guarda en
 * claro, como antes de ENG-216 (lo avisa al arrancar). Si está definida pero mal
 * formada, **falla**: arrancar con una clave rota terminaría en datos que nadie
 * puede leer. El mensaje nunca incluye el valor de una clave.
 */
export function parseKeyring(raw: string | undefined): Keyring | null {
  if (raw === undefined || raw.trim() === '') return null;

  const keys = new Map<string, Buffer>();
  let activeKid = '';
  for (const part of raw.split(',')) {
    const separator = part.indexOf(':');
    const kid = part.slice(0, separator).trim();
    const encoded = part.slice(separator + 1).trim();
    if (separator < 1 || !KID_PATTERN.test(kid)) {
      throw new Error(
        'DATA_ENCRYPTION_KEYS mal formada: cada clave va como kid:clave, con un kid de minúsculas, números o guiones.',
      );
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== encoded) {
      throw new Error(
        `DATA_ENCRYPTION_KEYS: la clave ${kid} tiene que ser base64 de exactamente ${KEY_BYTES} bytes.`,
      );
    }
    if (keys.has(kid)) {
      throw new Error(`DATA_ENCRYPTION_KEYS: el kid ${kid} está repetido.`);
    }
    for (const [otherKid, other] of keys) {
      if (timingSafeEqual(other, key)) {
        throw new Error(
          `DATA_ENCRYPTION_KEYS: ${kid} y ${otherKid} son la misma clave.`,
        );
      }
    }
    keys.set(kid, key);
    activeKid = kid;
  }
  return { activeKid, keys };
}

/** Una clave nueva al azar, en el formato de `DATA_ENCRYPTION_KEYS`. */
export function generateKeyEntry(kid: string): string {
  if (!KID_PATTERN.test(kid)) {
    throw new Error('El kid va en minúsculas, números o guiones (k1, k2…).');
  }
  return `${kid}:${randomBytes(KEY_BYTES).toString('base64')}`;
}

/** Una DEK nueva al azar. */
export function generateDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** AES-256-GCM con un nonce al azar. */
function encrypt(key: Buffer, plaintext: Buffer, aad: string) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, tag: cipher.getAuthTag(), ciphertext };
}

/** El inverso de `encrypt`. Cualquier diferencia termina en `DecryptionError`. */
function decrypt(
  key: Buffer,
  nonce: Buffer,
  tag: Buffer,
  ciphertext: Buffer,
  aad: string,
): Buffer {
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError('Formato cifrado inválido.');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

/** Cifra y devuelve `<nonce>.<etiqueta>.<texto>` en base64url. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const { nonce, tag, ciphertext } = encrypt(key, plaintext, aad);
  return [nonce, tag, ciphertext]
    .map((part) => part.toString('base64url'))
    .join('.');
}

/** Descifra lo que dejó `seal`. Cualquier diferencia termina en `DecryptionError`. */
export function open(key: Buffer, token: string, aad: string): Buffer {
  const parts = token.split('.');
  if (parts.length !== 3)
    throw new DecryptionError('Formato cifrado inválido.');
  const [nonce, tag, ciphertext] = parts.map((p) =>
    Buffer.from(p, 'base64url'),
  );
  return decrypt(key, nonce, tag, ciphertext, aad);
}

/**
 * Cabecera de un archivo cifrado. Un archivo se guarda en binario y no en
 * base64: `MCF1` + nonce + etiqueta + texto cifrado.
 */
const FILE_MAGIC = Buffer.from('MCF1', 'ascii');

/** Cuántos bytes suma el cifrado a un archivo. */
export const ENCRYPTED_FILE_OVERHEAD =
  FILE_MAGIC.length + NONCE_BYTES + TAG_BYTES;

/** Cifra un archivo entero. */
export function sealBytes(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const { nonce, tag, ciphertext } = encrypt(key, plaintext, aad);
  return Buffer.concat([FILE_MAGIC, nonce, tag, ciphertext]);
}

/** Descifra lo que dejó `sealBytes`. */
export function openBytes(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (
    blob.length < ENCRYPTED_FILE_OVERHEAD ||
    !blob.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)
  ) {
    throw new DecryptionError('Formato de archivo cifrado inválido.');
  }
  const nonceEnd = FILE_MAGIC.length + NONCE_BYTES;
  return decrypt(
    key,
    blob.subarray(FILE_MAGIC.length, nonceEnd),
    blob.subarray(nonceEnd, ENCRYPTED_FILE_OVERHEAD),
    blob.subarray(ENCRYPTED_FILE_OVERHEAD),
    aad,
  );
}

/**
 * Una subclave derivada de una KEK para otro uso (HKDF-SHA256). Así una misma
 * clave maestra no se usa directo para dos cosas distintas.
 */
export function deriveKey(kek: Buffer, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', kek, Buffer.alloc(0), `mediconnect:${purpose}`, 32),
  );
}

/** AAD de la DEK envuelta: la ata a su paciente y a la KEK que la envolvió. */
export function dataKeyAad(patientId: string, kid: string): string {
  return `mediconnect:dek:${patientId.toLowerCase()}:${kid}`;
}

/** Dónde vive un dato cifrado. Es el AAD: lo ata a su fila. */
export interface FieldLocation {
  table: string;
  rowId: string;
  field: string;
}

/**
 * Dónde vive el contenido de una entrada de la HC. Es el AAD de su cifrado: el
 * contenido cifrado de una entrada no se descifra pegado en otra.
 */
export function clinicalContentAt(entryId: string): FieldLocation {
  return { table: 'clinical_record_entries', rowId: entryId, field: 'content' };
}

/**
 * Dónde vive un archivo: su bucket y el nombre del objeto (el UUID al azar con
 * que se sube). Un archivo cifrado copiado a otro nombre o a otro bucket no se
 * descifra.
 */
export function storedFileAt(bucket: string, objectId: string): FieldLocation {
  return { table: `storage.${bucket}`, rowId: objectId, field: 'file' };
}

export function fieldAad(patientId: string, at: FieldLocation): string {
  return [
    'mediconnect',
    ENCRYPTION_VERSION,
    at.table,
    at.rowId.toLowerCase(),
    at.field,
    patientId.toLowerCase(),
  ].join(':');
}

/** Un JSON cifrado tal como se guarda en una columna `jsonb`. */
export interface EncryptedJson {
  [ENCRYPTED_JSON_KEY]: string;
}

export function isEncryptedJson(value: unknown): value is EncryptedJson {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>)[ENCRYPTED_JSON_KEY] === 'string'
  );
}

export function sealJson(
  key: Buffer,
  value: unknown,
  aad: string,
): EncryptedJson {
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  return {
    [ENCRYPTED_JSON_KEY]: `${ENCRYPTION_VERSION}.${seal(key, plaintext, aad)}`,
  };
}

export function openJson(
  key: Buffer,
  stored: EncryptedJson,
  aad: string,
): unknown {
  const token = stored[ENCRYPTED_JSON_KEY];
  const prefix = `${ENCRYPTION_VERSION}.`;
  if (!token.startsWith(prefix)) {
    throw new DecryptionError('Versión de cifrado desconocida.');
  }
  const plaintext = open(key, token.slice(prefix.length), aad);
  return JSON.parse(plaintext.toString('utf8')) as unknown;
}
