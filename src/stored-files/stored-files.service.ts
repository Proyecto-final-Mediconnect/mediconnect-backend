import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ClinicalDataCipher,
  type FileTicket,
} from '../common/crypto/clinical-data-cipher';
import {
  ENCRYPTED_FILE_OVERHEAD,
  storedFileAt,
} from '../common/crypto/data-encryption';
import { MAX_FILE_BYTES } from '../common/files/file-signature';
import { SupabaseService } from '../supabase/supabase.service';

/** Sufijo de un objeto cifrado en Storage: `<carpeta>/<uuid>.<ext>.enc`. */
export const ENCRYPTED_OBJECT_SUFFIX = '.enc';

/** Cuánto vive un link de descarga: lo justo para abrirlo (Sprint 0 §5.3.1). */
export const FILE_LINK_TTL_SECONDS = 5 * 60;

/** El mensaje de un link vencido, alterado o que no es de un archivo cifrado. */
export const INVALID_FILE_LINK =
  'El link venció o no es válido. Volvé a abrir el archivo desde MediConnect.';

/**
 * Los únicos buckets que sirve `GET /files`. Van escritos acá y no importados de
 * sus services para no armar un ciclo de imports.
 */
const SERVABLE_BUCKETS: ReadonlySet<string> = new Set([
  'patient-documents',
  'chat-attachments',
]);

const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  // El resumen de salud IPS (ENG-246).
  'application/fhir+json': 'json',
};

export function isEncryptedObject(path: string): boolean {
  return path.endsWith(ENCRYPTED_OBJECT_SUFFIX);
}

/** El UUID del nombre del objeto: `<carpeta>/<uuid>.<ext>[.enc]` → `<uuid>`. */
export function objectIdOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

/** Un archivo descifrado, listo para mandar. */
export interface OpenedFile {
  bytes: Buffer;
  mime: string;
  attachment: boolean;
  filename: string;
}

/**
 * ENG-216 parte 2 — Los archivos clínicos cifrados en Storage: los documentos
 * que aporta el paciente y los adjuntos del chat.
 *
 * - **Subir:** con el cifrado prendido, el archivo se cifra con la clave de
 *   datos del paciente antes de llegar a Storage, y el objeto termina en `.enc`.
 *   Sin `DATA_ENCRYPTION_KEYS` se sube en claro, como antes.
 * - **Abrir:** un archivo cifrado no se puede abrir con una URL firmada de
 *   Storage (bajaría el cifrado). El service que ya autorizó y auditó la
 *   apertura pide acá un link propio de cinco minutos (`GET /files?t=...`), y
 *   ese endpoint baja el objeto, lo descifra y lo manda. Para la web y el
 *   mobile no cambia nada: reciben una URL y la abren.
 * - Lo que se subió antes sigue en claro y se abre con la URL firmada de
 *   Storage, como siempre. El sufijo `.enc` es lo que distingue uno del otro.
 */
@Injectable()
export class StoredFilesService {
  private readonly logger = new Logger(StoredFilesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly cipher: ClinicalDataCipher,
  ) {}

  /**
   * El tope de un archivo antes de cifrar. Los buckets cortan en 10 MB y el
   * cifrado suma 32 bytes: un archivo justo en el tope no entraría cifrado.
   */
  get maxFileBytes(): number {
    return this.cipher.enabled
      ? MAX_FILE_BYTES - ENCRYPTED_FILE_OVERHEAD
      : MAX_FILE_BYTES;
  }

  /**
   * La ruta y el contenido a subir. Con el cifrado prendido, el contenido va
   * cifrado con la clave del paciente y la ruta termina en `.enc`.
   */
  async prepareUpload(
    bucket: string,
    folder: string,
    patientId: string,
    ext: string,
    bytes: Buffer,
  ): Promise<{ path: string; body: Buffer }> {
    const objectId = randomUUID();
    if (!this.cipher.enabled) {
      return { path: `${folder}/${objectId}.${ext}`, body: bytes };
    }
    return {
      path: `${folder}/${objectId}.${ext}${ENCRYPTED_OBJECT_SUFFIX}`,
      body: await this.cipher.sealFile(
        patientId,
        storedFileAt(bucket, objectId),
        bytes,
      ),
    };
  }

  /**
   * El link de cinco minutos para abrir un archivo cifrado. Quien lo pide ya
   * tiene que haber autorizado y auditado la apertura.
   */
  link(
    baseUrl: string,
    ticket: FileTicket,
    now: Date = new Date(),
  ): { url: string; expiresAt: string } {
    const token = this.cipher.signFileTicket(
      ticket,
      FILE_LINK_TTL_SECONDS,
      now,
    );
    return {
      url: `${baseUrl}/files?t=${encodeURIComponent(token)}`,
      expiresAt: new Date(
        now.getTime() + FILE_LINK_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  /**
   * Baja un archivo para leerlo en el backend (ENG-246: el resumen de salud que
   * se muestra ordenado), descifrándolo si está cifrado. Quien lo pide ya tiene
   * que haber autorizado y auditado la lectura.
   */
  async read(bucket: string, path: string, patientId: string): Promise<Buffer> {
    const { data, error } = await this.supabase
      .getServiceClient()
      .storage.from(bucket)
      .download(path);
    if (error || !data) {
      this.logger.error(
        `No se pudo bajar ${bucket}/${path}: ${error?.message ?? 'sin datos'}`,
      );
      throw new InternalServerErrorException(
        'No pudimos abrir el archivo. Probá de nuevo en unos minutos.',
      );
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    if (!isEncryptedObject(path)) return bytes;
    try {
      return await this.cipher.openFile(
        patientId,
        storedFileAt(bucket, objectIdOf(path)),
        bytes,
      );
    } catch (err) {
      this.logger.error(
        `No se pudo descifrar ${bucket}/${path}: ${(err as Error).name}`,
      );
      throw new InternalServerErrorException(
        'No pudimos abrir el archivo. Probá de nuevo en unos minutos.',
      );
    }
  }

  /** Baja y descifra el archivo de un link. Vencido o alterado: 404. */
  async open(token: string): Promise<OpenedFile> {
    const ticket = this.cipher.readFileTicket(token);
    if (
      !ticket ||
      !SERVABLE_BUCKETS.has(ticket.bucket) ||
      !isEncryptedObject(ticket.path)
    ) {
      throw new NotFoundException(INVALID_FILE_LINK);
    }

    const { data, error } = await this.supabase
      .getServiceClient()
      .storage.from(ticket.bucket)
      .download(ticket.path);
    if (error || !data) {
      this.logger.error(
        `No se pudo bajar ${ticket.bucket}/${ticket.path}: ${error?.message ?? 'sin datos'}`,
      );
      throw new InternalServerErrorException(
        'No pudimos abrir el archivo. Probá de nuevo en unos minutos.',
      );
    }

    let bytes: Buffer;
    try {
      bytes = await this.cipher.openFile(
        ticket.patientId,
        storedFileAt(ticket.bucket, objectIdOf(ticket.path)),
        Buffer.from(await data.arrayBuffer()),
      );
    } catch (err) {
      // Un archivo que no descifra está alterado o fuera de lugar: no se manda
      // nada. El log lleva el motivo, nunca el contenido.
      this.logger.error(
        `No se pudo descifrar ${ticket.bucket}/${ticket.path}: ${(err as Error).name}`,
      );
      throw new InternalServerErrorException(
        'No pudimos abrir el archivo. Probá de nuevo en unos minutos.',
      );
    }

    const ext = EXTENSIONS[ticket.mime] ?? 'bin';
    return {
      bytes,
      mime: ticket.mime,
      attachment: ticket.attachment,
      filename: `${ticket.attachment ? 'documento' : 'archivo'}.${ext}`,
    };
  }
}
