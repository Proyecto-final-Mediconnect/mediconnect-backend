import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  allowedExtension,
  MAX_FILE_BYTES,
} from '../common/files/file-signature';
import {
  findPdfActiveContent,
  pdfRiskMessage,
} from '../common/files/pdf-active-content';
import { PrismaService } from '../prisma/prisma.service';
import {
  FILE_LINK_TTL_SECONDS,
  isEncryptedObject,
  StoredFilesService,
} from '../stored-files/stored-files.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ClinicalRecordsService, sameUuid } from './clinical-records.service';
import {
  DEFAULT_DOCUMENTS_PAGE_SIZE,
  MAX_DOCUMENTS_PAGE_SIZE,
  type ListPatientDocumentsQueryDto,
} from './dto/list-patient-documents-query.dto';
import type {
  PatientDocumentType,
  UploadPatientDocumentDto,
} from './dto/upload-patient-document.dto';
import { InvalidIpsError, readIps, type IpsPreview } from './ips/read-ips';

export const PATIENT_DOCUMENTS_BUCKET = 'patient-documents';

/** El tope del bucket y de la tabla (`patient_documents_size_check`). */
export const MAX_DOCUMENT_BYTES = MAX_FILE_BYTES;

/**
 * Cuota por paciente, contando solo los documentos no retirados. Sin ella, una
 * cuenta puede llenar Storage (se paga por GB) y no hay forma de borrar.
 */
export const MAX_ACTIVE_DOCUMENTS_PER_PATIENT = 50;
export const MAX_TOTAL_BYTES_PER_PATIENT = 200 * 1024 * 1024;

/**
 * El resumen de salud IPS (ENG-246, ADR-022) se guarda con este tipo. Se acepta
 * también como `application/json`, que es lo que manda un navegador o un
 * celular para un `.json`.
 */
export const IPS_MIME_TYPE = 'application/fhir+json';
const IPS_UPLOAD_MIME_TYPES: ReadonlySet<string> = new Set([
  IPS_MIME_TYPE,
  'application/json',
]);
/** Un resumen IPS es texto: más que esto no es un resumen. */
export const MAX_IPS_BYTES = 1024 * 1024;

/** El resumen de salud, ordenado para mostrar. Sin el DNI del documento. */
export type IpsDocumentView = Omit<IpsPreview, 'documento'> & {
  documento: Omit<IpsPreview['documento'], 'dni'>;
};

/** Cuánto vive una URL de descarga: lo justo para abrirla (Sprint 0 §5.3.1). */
export const DOWNLOAD_URL_TTL_SECONDS = FILE_LINK_TTL_SECONDS;

/** Lo que Multer adjunta del archivo subido. */
export interface UploadedDocumentFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** Un documento aportado, como lo leen la web y la app. */
export interface PatientDocumentView {
  id: string;
  type: PatientDocumentType;
  title: string;
  /** `AAAA-MM-DD` o `null`. */
  documentDate: string | null;
  sourceInstitution: string | null;
  mimeType: string;
  sizeBytes: number;
  /** ISO-8601. */
  uploadedAt: string;
}

const VIEW_SELECT = {
  id: true,
  type: true,
  title: true,
  document_date: true,
  source_institution: true,
  mime_type: true,
  size_bytes: true,
  uploaded_at: true,
} as const;

type DocumentRow = {
  id: string;
  type: PatientDocumentType;
  title: string;
  document_date: Date | null;
  source_institution: string | null;
  mime_type: string;
  size_bytes: number;
  uploaded_at: Date;
};

function toView(row: DocumentRow): PatientDocumentView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    documentDate: row.document_date
      ? row.document_date.toISOString().slice(0, 10)
      : null,
    sourceInstitution: row.source_institution,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedAt: row.uploaded_at.toISOString(),
  };
}

/**
 * Documentación clínica previa que aporta el paciente (ENG-164): estudios,
 * epicrisis, informes y recetas que trae de otras instituciones.
 *
 * **No es historia clínica.** La HC la asientan los profesionales y la cadena de
 * hash (ENG-57) prueba exactamente eso; un PDF del paciente adentro rompería la
 * garantía. Esto va aparte, en `patient_documents`, y las pantallas lo muestran
 * como "aportado por el paciente · no validado".
 *
 * Los archivos viven en un bucket **privado**. Nadie los lee por URL pública:
 * se descargan con una URL firmada de cinco minutos que se arma con el token de
 * quien pide, así que Storage vuelve a chequear el permiso con sus propias
 * políticas (las mismas reglas que la HC).
 *
 * Desde ENG-216, con el cifrado prendido, el archivo se sube cifrado con la
 * clave del paciente y se abre con un link de cinco minutos del backend, que lo
 * descifra (`StoredFilesService`). Los subidos antes siguen como estaban.
 */
@Injectable()
export class PatientDocumentsService {
  private readonly logger = new Logger(PatientDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly records: ClinicalRecordsService,
    private readonly files: StoredFilesService,
  ) {}

  async upload(
    patientId: string,
    file: UploadedDocumentFile,
    dto: UploadPatientDocumentDto,
  ): Promise<PatientDocumentView> {
    // Primero lo vacío: sin bytes tampoco hay firma, y el mensaje correcto es este.
    if (file.size === 0) {
      throw new BadRequestException('El archivo está vacío.');
    }
    // El resumen de salud IPS (ENG-246) es un JSON: no tiene firma de bytes,
    // así que se valida leyéndolo entero.
    const ips = IPS_UPLOAD_MIME_TYPES.has(file.mimetype)
      ? this.parseIps(file)
      : null;
    // Se mira el contenido y no solo el `Content-Type` (ver `file-signature.ts`).
    const ext = ips ? 'json' : allowedExtension(file.mimetype, file.buffer);
    if (!ext) {
      throw new BadRequestException(
        'Solo se pueden subir PDF, JPG, PNG o un resumen de salud IPS.',
      );
    }
    if (file.size > this.files.maxFileBytes) {
      throw new BadRequestException('El archivo no puede pasar los 10 MB.');
    }
    // ENG-217: un PDF con JavaScript, adjuntos o acciones no entra.
    const risk = ext === 'pdf' ? findPdfActiveContent(file.buffer) : null;
    if (risk) {
      this.logger.warn(`PDF rechazado (${risk}) del paciente ${patientId}`);
      throw new BadRequestException(pdfRiskMessage(risk));
    }
    const mimeType = ips ? IPS_MIME_TYPE : file.mimetype;

    // La fila cuelga de `patients`: sin perfil completo no hay a quién colgarla.
    const patient = await this.prisma.patient.findUnique({
      where: { profile_id: patientId },
      select: { profile_id: true, dni: true },
    });
    if (!patient) {
      throw new ConflictException(
        'Completá tu perfil de paciente antes de subir documentos.',
      );
    }
    // El resumen de otra persona no entra a esta historia: el médico lo leería
    // como si fuera del paciente. Solo se compara si los dos traen DNI.
    const dniDelResumen = ips?.documento.dni;
    if (
      dniDelResumen &&
      patient.dni &&
      dniDelResumen !== patient.dni.replace(/\D/g, '')
    ) {
      throw new BadRequestException(
        'El DNI de este resumen de salud no es el tuyo, así que no lo sumamos a tu historia.',
      );
    }

    await this.assertWithinQuota(patientId, file.size);

    // El hash es del archivo original, no del cifrado: es el que identifica el
    // documento aunque cambie la clave.
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    // Nombre aleatorio y sin el nombre original: el nombre de un archivo puede
    // decir más de lo que hace falta ("VIH_positivo.pdf"). La carpeta es el
    // paciente, que es lo que miran las políticas de Storage. Con el cifrado
    // prendido, el contenido va cifrado y el nombre termina en `.enc`.
    const { path: storagePath, body } = await this.files.prepareUpload(
      PATIENT_DOCUMENTS_BUCKET,
      patientId,
      patientId,
      ext,
      file.buffer,
    );

    // Con service role y no con el token del paciente: el bucket no tiene política
    // de INSERT, así la única forma de subir pasa por acá (firma, rate limit, cuota
    // y fila). La carpeta sale del `userId` del JWT, nunca del request.
    const { error } = await this.supabase
      .getServiceClient()
      .storage.from(PATIENT_DOCUMENTS_BUCKET)
      .upload(storagePath, body, {
        contentType: mimeType,
        upsert: false,
      });
    if (error) {
      this.logger.error(`No se pudo subir ${storagePath}: ${error.message}`);
      throw new InternalServerErrorException(
        'No pudimos subir el archivo. Probá de nuevo en unos minutos.',
      );
    }

    try {
      const row = await this.prisma.patientDocument.create({
        data: {
          patient_id: patientId,
          type: dto.type,
          title: dto.title,
          // `AAAA-MM-DD` validado en el DTO, interpretado en UTC: es un día de
          // calendario y la zona horaria no puede correrlo.
          document_date: dto.documentDate
            ? new Date(`${dto.documentDate}T00:00:00.000Z`)
            : null,
          source_institution: dto.sourceInstitution ?? null,
          storage_path: storagePath,
          sha256,
          mime_type: mimeType,
          size_bytes: file.size,
        },
        select: VIEW_SELECT,
      });
      return toView(row);
    } catch (err) {
      // El archivo ya está en Storage y queda huérfano: nadie lo lista ni puede
      // firmarlo sin su fila. Se borraría con service role, pero un documento
      // clínico no se borra por una falla pasajera: queda logueado para limpiarlo.
      this.logger.error(
        `Se subió ${storagePath} pero no se pudo guardar su fila: ${String(err)}`,
      );
      throw new InternalServerErrorException(
        'No pudimos guardar el documento. Probá de nuevo en unos minutos.',
      );
    }
  }

  /**
   * Los documentos vigentes del paciente, del más nuevo al más viejo (desempate
   * por id, para que las páginas no repitan ni salteen). Devuelve un array;
   * `limit` (50 por defecto, 100 como tope) y `offset` paginan.
   */
  async listForPatient(
    patientId: string,
    page: ListPatientDocumentsQueryDto = {},
  ): Promise<PatientDocumentView[]> {
    const rows = await this.prisma.patientDocument.findMany({
      where: { patient_id: patientId, withdrawn_at: null },
      select: VIEW_SELECT,
      orderBy: [{ uploaded_at: 'desc' }, { id: 'desc' }],
      take: Math.min(
        page.limit ?? DEFAULT_DOCUMENTS_PAGE_SIZE,
        MAX_DOCUMENTS_PAGE_SIZE,
      ),
      skip: page.offset ?? 0,
    });
    return rows.map(toView);
  }

  /**
   * Los documentos de un paciente, para quien los pide. El paciente ve los
   * suyos; un profesional, los de un paciente cuya HC puede leer (mismas reglas:
   * turno que implique consulta o haber firmado una entrada). Si no, 403 con el
   * mismo mensaje que la HC.
   *
   * El listado de un profesional ya expone títulos sensibles ("VIH", "oncología"),
   * así que queda en `audit_logs` y **falla cerrado**, igual que la descarga.
   */
  async listFor(
    viewerId: string,
    patientId: string,
    page: ListPatientDocumentsQueryDto = {},
  ): Promise<PatientDocumentView[]> {
    if (sameUuid(viewerId, patientId)) {
      return this.listForPatient(patientId, page);
    }
    await this.records.assertCanReadFor(viewerId, patientId);
    const docs = await this.listForPatient(patientId, page);
    await this.auditProfessionalAccess(
      viewerId,
      'PATIENT_DOCUMENT_LIST',
      patientId,
      { patientId, count: docs.length },
    );
    return docs;
  }

  /**
   * Una URL de cinco minutos para ver el archivo: firmada por Storage, o un link
   * del backend si el archivo está cifrado (`baseUrl` es el origen del backend).
   *
   * Cada descarga queda en `audit_logs` (ENG-217). La de un profesional **falla
   * cerrado** como la lectura de la HC: si no se puede registrar, no se entrega
   * la URL. La del propio paciente se registra igual, pero si el registro falla
   * no se le niega su archivo.
   */
  async downloadUrl(
    viewerId: string,
    accessToken: string,
    documentId: string,
    baseUrl: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const doc = await this.prisma.patientDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        patient_id: true,
        storage_path: true,
        mime_type: true,
        withdrawn_at: true,
      },
    });
    // Retirado o inexistente dan lo mismo: no hay nada que mostrar.
    if (!doc || doc.withdrawn_at) {
      throw new NotFoundException('No encontramos ese documento.');
    }

    if (!sameUuid(viewerId, doc.patient_id)) {
      await this.records.assertCanReadFor(viewerId, doc.patient_id);
      await this.auditProfessionalAccess(
        viewerId,
        'PATIENT_DOCUMENT_DOWNLOAD',
        doc.id,
        { patientId: doc.patient_id },
      );
    } else {
      await this.auditOwnDownload(viewerId, doc.id);
    }

    if (isEncryptedObject(doc.storage_path)) {
      return this.files.link(baseUrl, {
        bucket: PATIENT_DOCUMENTS_BUCKET,
        path: doc.storage_path,
        patientId: doc.patient_id,
        mime: doc.mime_type,
        attachment: true,
      });
    }

    const { data, error } = await this.supabase
      .getClientForToken(accessToken)
      .storage.from(PATIENT_DOCUMENTS_BUCKET)
      .createSignedUrl(doc.storage_path, DOWNLOAD_URL_TTL_SECONDS, {
        download: true,
      });
    if (error || !data?.signedUrl) {
      this.logger.error(
        `No se pudo firmar ${doc.storage_path}: ${error?.message ?? 'sin URL'}`,
      );
      throw new InternalServerErrorException(
        'No pudimos abrir el documento. Probá de nuevo en unos minutos.',
      );
    }
    return {
      url: data.signedUrl,
      expiresAt: new Date(
        Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  /**
   * El resumen de salud IPS de un documento, ordenado para mostrar (ENG-246):
   * problemas, alergias, medicación y vacunas. Mismas reglas de acceso y de
   * auditoría que abrir el archivo: el paciente lee los suyos; un profesional,
   * los de un paciente cuya HC puede leer, y si no se puede registrar el acceso
   * no se muestra nada.
   *
   * Antes de leerlo se compara con el SHA-256 que se guardó al subirlo: si el
   * archivo no es el mismo, no se muestra.
   */
  async ipsSummary(
    viewerId: string,
    documentId: string,
  ): Promise<IpsDocumentView> {
    const doc = await this.prisma.patientDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        patient_id: true,
        storage_path: true,
        mime_type: true,
        sha256: true,
        withdrawn_at: true,
      },
    });
    if (!doc || doc.withdrawn_at) {
      throw new NotFoundException('No encontramos ese documento.');
    }

    const propio = sameUuid(viewerId, doc.patient_id);
    if (!propio) {
      await this.records.assertCanReadFor(viewerId, doc.patient_id);
    }
    if (doc.mime_type !== IPS_MIME_TYPE) {
      throw new NotFoundException('Ese documento no es un resumen de salud.');
    }
    if (propio) {
      await this.auditOwnDownload(viewerId, doc.id, 'PATIENT_DOCUMENT_VIEW');
    } else {
      await this.auditProfessionalAccess(
        viewerId,
        'PATIENT_DOCUMENT_VIEW',
        doc.id,
        { patientId: doc.patient_id },
      );
    }

    const bytes = await this.files.read(
      PATIENT_DOCUMENTS_BUCKET,
      doc.storage_path,
      doc.patient_id,
    );
    if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256) {
      this.logger.error(
        `El documento ${doc.id} no coincide con el SHA-256 que se guardó al subirlo`,
      );
      throw new InternalServerErrorException(
        'Este documento no coincide con el que se subió, así que no lo mostramos.',
      );
    }

    let preview: IpsPreview;
    try {
      preview = readIps(JSON.parse(bytes.toString('utf8')));
    } catch {
      // Se validó al subirlo: si ahora no se puede leer, algo cambió.
      throw new InternalServerErrorException(
        'No pudimos leer este resumen de salud. Probá de nuevo en unos minutos.',
      );
    }
    const { titulo, fecha } = preview.documento;
    return { ...preview, documento: { titulo, fecha } };
  }

  /**
   * Lee y valida un resumen de salud IPS que se está subiendo. Si no es uno, 400
   * con un mensaje para la persona. Nunca se loguea el contenido.
   */
  private parseIps(file: UploadedDocumentFile): IpsPreview {
    if (file.size > MAX_IPS_BYTES) {
      throw new BadRequestException('El resumen de salud no puede pasar 1 MB.');
    }
    let json: unknown;
    try {
      json = JSON.parse(file.buffer.toString('utf8'));
    } catch {
      throw new BadRequestException(
        'No pudimos leer el archivo: el resumen de salud tiene que ser un JSON válido.',
      );
    }
    try {
      return readIps(json);
    } catch (err) {
      throw new BadRequestException(
        err instanceof InvalidIpsError
          ? err.message
          : 'No pudimos leer el archivo. Revisá que sea un resumen de salud IPS.',
      );
    }
  }

  /**
   * Retira un documento propio: deja de mostrarse pero queda registrado. Es la
   * única escritura que admite el trigger de `patient_documents`.
   */
  async withdraw(patientId: string, documentId: string, now = new Date()) {
    // Un solo UPDATE condicional: es atómico. Con dos DELETE a la vez uno solo
    // gana y el otro ve `count` 0 (no llega al trigger, que lo tiraría como 500).
    // Ajeno, retirado e inexistente dan el mismo 404: un 403 diría que existe.
    const { count } = await this.prisma.patientDocument.updateMany({
      where: { id: documentId, patient_id: patientId, withdrawn_at: null },
      data: { withdrawn_at: now },
    });
    if (count === 0) {
      throw new NotFoundException('No encontramos ese documento.');
    }
  }

  /**
   * Rechaza la subida si el paciente pasaría la cuota (cantidad de documentos o
   * bytes), contando solo los no retirados. No es atómica contra subidas
   * simultáneas: el rate limit las acota y el tope es de costos, no de seguridad.
   */
  private async assertWithinQuota(patientId: string, incomingBytes: number) {
    const { _count, _sum } = await this.prisma.patientDocument.aggregate({
      where: { patient_id: patientId, withdrawn_at: null },
      _count: { _all: true },
      _sum: { size_bytes: true },
    });
    if (_count._all >= MAX_ACTIVE_DOCUMENTS_PER_PATIENT) {
      throw new UnprocessableEntityException(
        `Llegaste al máximo de ${MAX_ACTIVE_DOCUMENTS_PER_PATIENT} documentos. Retirá alguno para subir otro.`,
      );
    }
    if ((_sum.size_bytes ?? 0) + incomingBytes > MAX_TOTAL_BYTES_PER_PATIENT) {
      throw new UnprocessableEntityException(
        `Tus documentos no pueden pasar los ${MAX_TOTAL_BYTES_PER_PATIENT / 1024 / 1024} MB en total. Retirá alguno para subir otro.`,
      );
    }
  }

  /** La descarga del propio paciente: se registra, pero sin negarle su archivo. */
  private async auditOwnDownload(
    patientId: string,
    documentId: string,
    action:
      | 'PATIENT_DOCUMENT_DOWNLOAD'
      | 'PATIENT_DOCUMENT_VIEW' = 'PATIENT_DOCUMENT_DOWNLOAD',
  ) {
    try {
      await this.prisma.auditLog.create({
        data: {
          actor_id: patientId,
          action,
          resource_type: 'patient_documents',
          resource_id: documentId,
          metadata: { patientId },
        },
      });
    } catch (err) {
      this.logger.warn(
        `No se pudo auditar la descarga de ${documentId} por su paciente: ${String(err)}`,
      );
    }
  }

  /** Deja el acceso de un profesional en `audit_logs`; si falla, no se entrega nada. */
  private async auditProfessionalAccess(
    viewerId: string,
    action:
      | 'PATIENT_DOCUMENT_DOWNLOAD'
      | 'PATIENT_DOCUMENT_LIST'
      | 'PATIENT_DOCUMENT_VIEW',
    resourceId: string,
    metadata: Record<string, string | number>,
  ) {
    try {
      await this.prisma.auditLog.create({
        data: {
          actor_id: viewerId,
          action,
          resource_type: 'patient_documents',
          resource_id: resourceId,
          metadata,
        },
      });
    } catch (err) {
      this.logger.error(
        `No se pudo auditar ${action} de ${resourceId} por ${viewerId}: ${String(err)}`,
      );
      throw new InternalServerErrorException(
        'No pudimos registrar el acceso al documento, así que no lo mostramos. Probá de nuevo en unos minutos.',
      );
    }
  }
}
