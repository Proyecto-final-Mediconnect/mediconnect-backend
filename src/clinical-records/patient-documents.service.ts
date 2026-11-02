import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
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

export const PATIENT_DOCUMENTS_BUCKET = 'patient-documents';

/** El tope del bucket y de la tabla (`patient_documents_size_check`). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * Cuota por paciente, contando solo los documentos no retirados. Sin ella, una
 * cuenta puede llenar Storage (se paga por GB) y no hay forma de borrar.
 */
export const MAX_ACTIVE_DOCUMENTS_PER_PATIENT = 50;
export const MAX_TOTAL_BYTES_PER_PATIENT = 200 * 1024 * 1024;

/** Cuánto vive una URL de descarga: lo justo para abrirla (Sprint 0 §5.3.1). */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * Los tipos aceptados, con la firma con la que empieza cada archivo. Se mira el
 * contenido y no solo el `Content-Type`, que lo pone el cliente: un ejecutable
 * renombrado a `.pdf` no entra.
 */
// Un `Map` y no un objeto: `Content-Type` lo manda el cliente y `constructor` o
// `__proto__` no pueden resolver a nada del prototipo.
const ALLOWED = new Map<string, { ext: string; magic: number[] }>([
  ['application/pdf', { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] }], // %PDF
  ['image/png', { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] }],
  ['image/jpeg', { ext: 'jpg', magic: [0xff, 0xd8, 0xff] }],
]);

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
 */
@Injectable()
export class PatientDocumentsService {
  private readonly logger = new Logger(PatientDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly records: ClinicalRecordsService,
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
    const tipo = ALLOWED.get(file.mimetype);
    if (!tipo || !startsWith(file.buffer, tipo.magic)) {
      throw new BadRequestException('Solo se pueden subir PDF, JPG o PNG.');
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException('El archivo no puede pasar los 10 MB.');
    }

    // La fila cuelga de `patients`: sin perfil completo no hay a quién colgarla.
    const patient = await this.prisma.patient.findUnique({
      where: { profile_id: patientId },
      select: { profile_id: true },
    });
    if (!patient) {
      throw new ConflictException(
        'Completá tu perfil de paciente antes de subir documentos.',
      );
    }

    await this.assertWithinQuota(patientId, file.size);

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    // Nombre aleatorio y sin el nombre original: el nombre de un archivo puede
    // decir más de lo que hace falta ("VIH_positivo.pdf"). La carpeta es el
    // paciente, que es lo que miran las políticas de Storage.
    const storagePath = `${patientId}/${randomUUID()}.${tipo.ext}`;

    // Con service role y no con el token del paciente: el bucket no tiene política
    // de INSERT, así la única forma de subir pasa por acá (firma, rate limit, cuota
    // y fila). La carpeta sale del `userId` del JWT, nunca del request.
    const { error } = await this.supabase
      .getServiceClient()
      .storage.from(PATIENT_DOCUMENTS_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
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
          mime_type: file.mimetype,
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
   * Una URL firmada de cinco minutos para ver el archivo.
   *
   * Cada descarga de un profesional queda en `audit_logs`, y **falla cerrado**
   * como la lectura de la HC: si no se puede registrar, no se entrega la URL.
   */
  async downloadUrl(
    viewerId: string,
    accessToken: string,
    documentId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const doc = await this.prisma.patientDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        patient_id: true,
        storage_path: true,
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

  /** Deja el acceso de un profesional en `audit_logs`; si falla, no se entrega nada. */
  private async auditProfessionalAccess(
    viewerId: string,
    action: 'PATIENT_DOCUMENT_DOWNLOAD' | 'PATIENT_DOCUMENT_LIST',
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

function startsWith(buffer: Buffer, magic: number[]): boolean {
  return magic.every((byte, i) => buffer[i] === byte);
}
