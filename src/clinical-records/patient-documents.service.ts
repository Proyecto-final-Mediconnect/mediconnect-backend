import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ClinicalRecordsService, sameUuid } from './clinical-records.service';
import type {
  PatientDocumentType,
  UploadPatientDocumentDto,
} from './dto/upload-patient-document.dto';

export const PATIENT_DOCUMENTS_BUCKET = 'patient-documents';

/** El tope del bucket y de la tabla (`patient_documents_size_check`). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Cuánto vive una URL de descarga: lo justo para abrirla (Sprint 0 §5.3.1). */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * Los tipos aceptados, con la firma con la que empieza cada archivo. Se mira el
 * contenido y no solo el `Content-Type`, que lo pone el cliente: un ejecutable
 * renombrado a `.pdf` no entra.
 */
const ALLOWED: Record<string, { ext: string; magic: number[] }> = {
  'application/pdf': { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
};

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
    accessToken: string,
    patientId: string,
    file: UploadedDocumentFile,
    dto: UploadPatientDocumentDto,
  ): Promise<PatientDocumentView> {
    const tipo = ALLOWED[file.mimetype];
    if (!tipo || !startsWith(file.buffer, tipo.magic)) {
      throw new BadRequestException('Solo se pueden subir PDF, JPG o PNG.');
    }
    if (file.size === 0) {
      throw new BadRequestException('El archivo está vacío.');
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

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    // Nombre aleatorio y sin el nombre original: el nombre de un archivo puede
    // decir más de lo que hace falta ("VIH_positivo.pdf"). La carpeta es el
    // paciente, que es lo que miran las políticas de Storage.
    const storagePath = `${patientId}/${randomUUID()}.${tipo.ext}`;

    const { error } = await this.supabase
      .getClientForToken(accessToken)
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
          document_date: dto.documentDate ? new Date(dto.documentDate) : null,
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
      // firmarlo sin su fila. No se borra porque el bucket no admite DELETE.
      this.logger.error(
        `Se subió ${storagePath} pero no se pudo guardar su fila: ${String(err)}`,
      );
      throw new InternalServerErrorException(
        'No pudimos guardar el documento. Probá de nuevo en unos minutos.',
      );
    }
  }

  /** Los documentos vigentes del paciente, del más nuevo al más viejo. */
  async listForPatient(patientId: string): Promise<PatientDocumentView[]> {
    const rows = await this.prisma.patientDocument.findMany({
      where: { patient_id: patientId, withdrawn_at: null },
      select: VIEW_SELECT,
      orderBy: { uploaded_at: 'desc' },
    });
    return rows.map(toView);
  }

  /**
   * Los documentos de un paciente, para quien los pide. El paciente ve los
   * suyos; un profesional, los de un paciente cuya HC puede leer (mismas reglas:
   * turno que implique consulta o haber firmado una entrada). Si no, 403 con el
   * mismo mensaje que la HC.
   */
  async listFor(viewerId: string, patientId: string) {
    if (!sameUuid(viewerId, patientId)) {
      await this.records.assertCanReadFor(viewerId, patientId);
    }
    return this.listForPatient(patientId);
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
      try {
        await this.prisma.auditLog.create({
          data: {
            actor_id: viewerId,
            action: 'PATIENT_DOCUMENT_DOWNLOAD',
            resource_type: 'patient_documents',
            resource_id: doc.id,
            metadata: { patientId: doc.patient_id },
          },
        });
      } catch (err) {
        this.logger.error(
          `No se pudo auditar la descarga de ${doc.id} por ${viewerId}: ${String(err)}`,
        );
        throw new InternalServerErrorException(
          'No pudimos registrar el acceso al documento, así que no lo mostramos. Probá de nuevo en unos minutos.',
        );
      }
    }

    const { data, error } = await this.supabase
      .getClientForToken(accessToken)
      .storage.from(PATIENT_DOCUMENTS_BUCKET)
      .createSignedUrl(doc.storage_path, DOWNLOAD_URL_TTL_SECONDS);
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
    const doc = await this.prisma.patientDocument.findUnique({
      where: { id: documentId },
      select: { patient_id: true, withdrawn_at: true },
    });
    if (!doc || doc.withdrawn_at) {
      throw new NotFoundException('No encontramos ese documento.');
    }
    if (!sameUuid(doc.patient_id, patientId)) {
      throw new ForbiddenException(
        'Solo podés retirar tus propios documentos.',
      );
    }
    await this.prisma.patientDocument.update({
      where: { id: documentId },
      data: { withdrawn_at: now },
    });
  }
}

function startsWith(buffer: Buffer, magic: number[]): boolean {
  return magic.every((byte, i) => buffer[i] === byte);
}
