/**
 * ENG-216 — Cifra y descifra el contenido clínico de un paciente con su DEK.
 *
 * Es la única pieza que toca `patient_data_keys`. La usan el service de la HC,
 * la exportación de datos y la verificación de integridad (que corre fuera de
 * Nest, en GitHub Actions; por eso esta clase no depende de Nest).
 *
 * Reglas:
 * - **Sin `DATA_ENCRYPTION_KEYS`** el cifrado está apagado: lo nuevo se guarda
 *   en claro, como antes. Leer algo cifrado sin la clave falla (`MissingKeyError`):
 *   nunca se devuelve un dato cifrado como si fuera el contenido.
 * - **Con la clave**, todo lo nuevo se cifra. Lo viejo, en claro, se sigue
 *   leyendo igual: el formato se reconoce por la marca `$enc`.
 * - Ningún mensaje ni log lleva una clave ni un contenido.
 */
import type { PrismaService } from '../../prisma/prisma.service';
import {
  dataKeyAad,
  DecryptionError,
  fieldAad,
  generateDataKey,
  isEncryptedJson,
  MissingKeyError,
  open,
  openJson,
  parseKeyring,
  seal,
  sealJson,
  type FieldLocation,
  type Keyring,
} from './data-encryption';

type KeyStore = Pick<PrismaService, 'patientDataKey'>;

/** Abre los valores cifrados de UN paciente. La DEK se busca una sola vez. */
export type PatientOpener = (at: FieldLocation, stored: unknown) => unknown;

export class ClinicalDataCipher {
  constructor(
    private readonly store: KeyStore,
    private readonly keyring: Keyring | null,
  ) {}

  /** Arma el cipher con la clave de `DATA_ENCRYPTION_KEYS`. */
  static fromEnv(store: KeyStore, env = process.env): ClinicalDataCipher {
    return new ClinicalDataCipher(
      store,
      parseKeyring(env.DATA_ENCRYPTION_KEYS),
    );
  }

  /** Si lo nuevo se guarda cifrado. */
  get enabled(): boolean {
    return this.keyring !== null;
  }

  /** La KEK con la que se envuelven las DEK nuevas (para el log de arranque). */
  get activeKid(): string | null {
    return this.keyring?.activeKid ?? null;
  }

  /**
   * Cifra un JSON en su lugar. Con el cifrado apagado, lo devuelve tal cual.
   * La primera vez que un paciente necesita su DEK, se crea.
   */
  async sealJson(
    patientId: string,
    at: FieldLocation,
    value: unknown,
  ): Promise<unknown> {
    if (!this.keyring) return value;
    const dek = await this.dataKeyFor(patientId, { create: true });
    if (!dek) {
      // Solo pasa si la fila desaparece entre el INSERT y la relectura.
      throw new Error('No se pudo obtener la clave de datos del paciente.');
    }
    return sealJson(dek, value, fieldAad(patientId, at));
  }

  /**
   * Devuelve una función que abre los valores de un paciente. La DEK se busca
   * una sola vez (una consulta por paciente, no por fila); con el cifrado
   * apagado no se consulta nada.
   *
   * Se usa así porque todos los que leen la HC leen de a un paciente:
   * `const openValue = await cipher.openerFor(patientId)` y después
   * `openValue(lugar, fila.content)` por cada fila.
   */
  async openerFor(patientId: string): Promise<PatientOpener> {
    let dek: Buffer | null = null;
    // Se resuelve antes para que el opener sea sincrónico: si el paciente ya
    // tiene DEK, se trae ahora; si no la tiene, no puede tener nada cifrado.
    if (this.keyring) {
      dek = await this.dataKeyFor(patientId, { create: false });
    }
    return (at, stored) => {
      if (!isEncryptedJson(stored)) return stored;
      if (!this.keyring) {
        throw new MissingKeyError(
          'Hay contenido clínico cifrado y DATA_ENCRYPTION_KEYS no está configurada.',
        );
      }
      if (!dek) {
        // Cifrado sin DEK: la fila de la clave falta o la borraron.
        throw new DecryptionError(
          'El contenido está cifrado y el paciente no tiene clave de datos.',
        );
      }
      return openJson(dek, stored, fieldAad(patientId, at));
    };
  }

  /**
   * La DEK del paciente, desenvuelta. Con `create`, la crea si no existe.
   *
   * La creación es a prueba de carreras: dos escrituras simultáneas de un mismo
   * paciente nuevo insertan con `skipDuplicates` y las dos releen la fila que
   * quedó, así que usan la misma DEK.
   */
  private async dataKeyFor(
    patientId: string,
    { create }: { create: boolean },
  ): Promise<Buffer | null> {
    const keyring = this.keyring!;
    let row = await this.store.patientDataKey.findUnique({
      where: { patient_id: patientId },
      select: { kid: true, wrapped_dek: true },
    });

    if (!row && create) {
      const dek = generateDataKey();
      await this.store.patientDataKey.createMany({
        data: [
          {
            patient_id: patientId,
            kid: keyring.activeKid,
            wrapped_dek: seal(
              keyring.keys.get(keyring.activeKid)!,
              dek,
              dataKeyAad(patientId, keyring.activeKid),
            ),
          },
        ],
        skipDuplicates: true,
      });
      row = await this.store.patientDataKey.findUnique({
        where: { patient_id: patientId },
        select: { kid: true, wrapped_dek: true },
      });
    }
    if (!row) return null;

    const kek = keyring.keys.get(row.kid);
    if (!kek) {
      throw new MissingKeyError(
        `La clave de datos del paciente está envuelta con la clave maestra ${row.kid}, que no está en DATA_ENCRYPTION_KEYS.`,
      );
    }
    return open(kek, row.wrapped_dek, dataKeyAad(patientId, row.kid));
  }
}
