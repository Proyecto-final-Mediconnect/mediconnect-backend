import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  allowedExtension,
  MAX_FILE_BYTES,
} from '../common/files/file-signature';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  ConversationsService,
  type ChatMessage,
} from './conversations.service';

export const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';

/** Cuánto vive la URL para abrir un archivo: lo justo para abrirlo. */
export const ATTACHMENT_URL_TTL_SECONDS = 5 * 60;

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
 */
@Injectable()
export class ChatAttachmentsService {
  private readonly logger = new Logger(ChatAttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly conversations: ConversationsService,
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
    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException('El archivo no puede pasar los 10 MB.');
    }

    // Antes de subir nada: un archivo de una conversación ajena no llega a Storage.
    await this.conversations.assertParticipant(userId, conversationId);

    const path = `${conversationId}/${randomUUID()}.${ext}`;
    const storage = this.supabase
      .getServiceClient()
      .storage.from(CHAT_ATTACHMENTS_BUCKET);

    const { error } = await storage.upload(path, file.buffer, {
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
   * Una URL firmada de cinco minutos para abrir el archivo de un mensaje.
   *
   * Un mensaje ajeno, sin archivo o inexistente dan el mismo 404: un 403
   * confirmaría que existe.
   */
  async url(
    userId: string,
    accessToken: string,
    conversationId: string,
    messageId: string,
  ): Promise<{ url: string; expiraEl: string }> {
    await this.conversations.assertParticipant(userId, conversationId);

    const message = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversation_id: conversationId,
        attachment_url: { not: null },
      },
      select: { attachment_url: true },
    });
    if (!message?.attachment_url) {
      throw new NotFoundException('No encontramos ese archivo.');
    }

    const { data, error } = await this.supabase
      .getClientForToken(accessToken)
      .storage.from(CHAT_ATTACHMENTS_BUCKET)
      .createSignedUrl(message.attachment_url, ATTACHMENT_URL_TTL_SECONDS);
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
}
