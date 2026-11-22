import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { allowedExtension } from '../common/files/file-signature';
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
import {
  ConversationsService,
  type ChatMessage,
} from './conversations.service';

export const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';

/** Cuánto vive la URL para abrir un archivo: lo justo para abrirlo. */
export const ATTACHMENT_URL_TTL_SECONDS = FILE_LINK_TTL_SECONDS;

/**
 * Tope de archivos que puede haber mandado una persona en el chat, sumando todas
 * sus conversaciones. Mismo criterio de costos que los documentos del paciente
 * (`MAX_TOTAL_BYTES_PER_PATIENT`): evita llenar Storage con subidas repetidas.
 */
export const MAX_CHAT_BYTES_PER_USER = 200 * 1024 * 1024;

/** Lo que Multer adjunta del archivo subido. */
export interface UploadedChatFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/**
 * Archivos en el chat (ENG-102): una foto, un estudio en PDF, una receta.
 *
 * ## Dónde viven
 *
 * En el bucket **privado** `chat-attachments`, en la carpeta de la
 * conversación: `<conversation_id>/<uuid>.<ext>`. El nombre es aleatorio y no
 * guarda el original, que puede decir más de lo que hace falta
 * ("resultado_VIH.pdf").
 *
 * - **Subir:** solo el backend, con service role. El bucket no tiene política
 *   de INSERT, así que nadie sube salteando la validación del archivo, el rate
 *   limit y la fila en `messages`.
 * - **Abrir:** con una URL firmada de cinco minutos que se arma **con el token
 *   de quien pide**. Storage vuelve a chequear con su propia política que sea
 *   participante de la conversación, la misma regla que la de `messages`.
 *   Cada apertura queda en `audit_logs` (ENG-217).
 * - **PDF con contenido activo** (JavaScript, adjuntos, acciones): se rechazan
 *   al subir (`pdf-active-content.ts`).
 * - **Cifrado (ENG-216):** con `DATA_ENCRYPTION_KEYS`, el archivo se sube
 *   cifrado con la clave de datos del paciente de la conversación, y se abre
 *   con un link de cinco minutos del backend que lo descifra
 *   (`StoredFilesService`). Los mandados antes siguen como estaban.
 */
@Injectable()
export class ChatAttachmentsService {
  private readonly logger = new Logger(ChatAttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly conversations: ConversationsService,
    private readonly files: StoredFilesService,
  ) {}

  /** Manda un mensaje con un archivo y, opcionalmente, un texto que lo acompaña. */
  async send(
    userId: string,
    conversationId: string,
    file: UploadedChatFile,
    content: string | undefined,
    now: Date = new Date(),
  ): Promise<ChatMessage> {
    if (file.size === 0) {
      throw new BadRequestException('El archivo está vacío.');
    }
    const ext = allowedExtension(file.mimetype, file.buffer);
    if (!ext) {
      throw new BadRequestException('Solo se pueden mandar PDF, JPG o PNG.');
    }
    if (file.size > this.files.maxFileBytes) {
      throw new BadRequestException('El archivo no puede pasar los 10 MB.');
    }
    // ENG-217: un PDF con JavaScript, adjuntos o acciones no entra.
    const risk = ext === 'pdf' ? findPdfActiveContent(file.buffer) : null;
    if (risk) {
      this.logger.warn(`PDF rechazado (${risk}) en el chat, de ${userId}`);
      throw new BadRequestException(pdfRiskMessage(risk));
    }

    // Antes de subir nada: un archivo de una conversación ajena no llega a Storage.
    const { patient_id: patientId } =
      await this.conversations.assertParticipant(userId, conversationId);

    await this.assertWithinQuota(userId, file.size);

    const { path, body } = await this.files.prepareUpload(
      CHAT_ATTACHMENTS_BUCKET,
      conversationId,
      patientId,
      ext,
      file.buffer,
    );
    const storage = this.supabase
      .getServiceClient()
      .storage.from(CHAT_ATTACHMENTS_BUCKET);

    const { error } = await storage.upload(path, body, {
      contentType: file.mimetype,
      upsert: false,
    });
    if (error) {
      this.logger.error(`No se pudo subir ${path}: ${error.message}`);
      throw new InternalServerErrorException(
        'No pudimos mandar el archivo. Probá de nuevo en unos minutos.',
      );
    }

    try {
      return await this.conversations.sendWithAttachment(
        userId,
        conversationId,
        {
          path,
          mime: file.mimetype,
          size: file.size,
          content: content?.trim() || null,
        },
        now,
      );
    } catch (err) {
      // Sin la fila nadie puede ver ni firmar el archivo: se borra. A diferencia
      // de un documento clínico (ENG-164), un adjunto que no llegó a mandarse no
      // es un registro que haya que conservar.
      const { error: removeError } = await storage.remove([path]);
      if (removeError) {
        this.logger.error(
          `Quedó huérfano ${path} en ${CHAT_ATTACHMENTS_BUCKET}: ${removeError.message}`,
        );
      }
      throw err;
    }
  }

  /**
   * Rechaza el envío si `userId` pasaría el tope de bytes en el chat. No es
   * atómica contra envíos simultáneos: el rate limit los acota y el tope es de
   * costos, no de seguridad.
   */
  private async assertWithinQuota(userId: string, incomingBytes: number) {
    const { _sum } = await this.prisma.message.aggregate({
      where: { sender_id: userId, attachment_url: { not: null } },
      _sum: { attachment_size: true },
    });
    if ((_sum.attachment_size ?? 0) + incomingBytes > MAX_CHAT_BYTES_PER_USER) {
      throw new UnprocessableEntityException(
        `Los archivos que mandaste por chat no pueden pasar los ${MAX_CHAT_BYTES_PER_USER / 1024 / 1024} MB en total.`,
      );
    }
  }

  /**
   * Una URL de cinco minutos para abrir el archivo de un mensaje: firmada por
   * Storage, o un link del backend si el archivo está cifrado (`baseUrl` es el
   * origen del backend).
   *
   * Un mensaje ajeno, sin archivo o inexistente dan el mismo 404: un 403
   * confirmaría que existe.
   *
   * Cada apertura queda en `audit_logs` (ENG-217). La de un archivo que mandó
   * el otro **falla cerrado**, como la descarga de un documento del paciente:
   * un estudio puede viajar por el chat. La del propio archivo se registra igual,
   * pero si el registro falla no se le niega a quien lo mandó.
   */
  async url(
    userId: string,
    accessToken: string,
    conversationId: string,
    messageId: string,
    baseUrl: string,
  ): Promise<{ url: string; expiraEl: string }> {
    const { patient_id: patientId } =
      await this.conversations.assertParticipant(userId, conversationId);

    const message = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversation_id: conversationId,
        attachment_url: { not: null },
      },
      select: { attachment_url: true, attachment_mime: true, sender_id: true },
    });
    if (!message?.attachment_url) {
      throw new NotFoundException('No encontramos ese archivo.');
    }

    await this.auditOpen(userId, conversationId, messageId, message.sender_id);

    if (isEncryptedObject(message.attachment_url)) {
      const { url, expiresAt } = this.files.link(baseUrl, {
        bucket: CHAT_ATTACHMENTS_BUCKET,
        path: message.attachment_url,
        patientId,
        // `attachment_mime` va de la mano del archivo (CHECK de `messages`).
        mime: message.attachment_mime ?? 'application/octet-stream',
        // Como abajo: un PDF de la contraparte se baja, no se renderiza.
        attachment: message.attachment_mime === 'application/pdf',
      });
      return { url, expiraEl: expiresAt };
    }

    const { data, error } = await this.supabase
      .getClientForToken(accessToken)
      .storage.from(CHAT_ATTACHMENTS_BUCKET)
      .createSignedUrl(
        message.attachment_url,
        ATTACHMENT_URL_TTL_SECONDS,
        // Un PDF de la contraparte no se renderiza en el navegador (puede traer
        // JavaScript embebido): se baja y se abre con el visor del dispositivo.
        message.attachment_mime === 'application/pdf'
          ? { download: true }
          : undefined,
      );
    if (error || !data?.signedUrl) {
      this.logger.error(
        `No se pudo firmar ${message.attachment_url}: ${error?.message ?? 'sin URL'}`,
      );
      throw new InternalServerErrorException(
        'No pudimos abrir el archivo. Probá de nuevo en unos minutos.',
      );
    }
    return {
      url: data.signedUrl,
      expiraEl: new Date(
        Date.now() + ATTACHMENT_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  /** Registra quién abrió el archivo. Ver `url` para cuándo falla cerrado. */
  private async auditOpen(
    userId: string,
    conversationId: string,
    messageId: string,
    senderId: string,
  ) {
    const own = userId === senderId;
    try {
      await this.prisma.auditLog.create({
        data: {
          actor_id: userId,
          action: 'CHAT_ATTACHMENT_DOWNLOAD',
          resource_type: 'messages',
          resource_id: messageId,
          metadata: { conversationId, own },
        },
      });
    } catch (err) {
      this.logger.error(
        `No se pudo auditar la apertura del adjunto ${messageId} por ${userId}: ${String(err)}`,
      );
      if (!own) {
        throw new InternalServerErrorException(
          'No pudimos registrar el acceso al archivo, así que no lo mostramos. Probá de nuevo en unos minutos.',
        );
      }
    }
  }
}
