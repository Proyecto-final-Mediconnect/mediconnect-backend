import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { SupabaseService } from '../supabase/supabase.service';
import {
  ATTACHMENT_URL_TTL_SECONDS,
  CHAT_ATTACHMENTS_BUCKET,
  ChatAttachmentsService,
} from './chat-attachments.service';
import type {
  ChatMessage,
  ConversationsService,
} from './conversations.service';

const USER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';

const PDF = Buffer.from('%PDF-1.7 contenido');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

const ENVIADO: ChatMessage = {
  id: MESSAGE,
  conversacionId: CONVERSATION,
  autorId: USER,
  contenido: 'El estudio',
  enviadoEl: '2026-11-04T12:00:00.000Z',
  leidoEl: null,
  adjunto: { tipo: 'application/pdf', tamano: PDF.length },
};

/** Archivos en el chat (ENG-102), contra Storage y el chat mockeados. */
describe('ChatAttachmentsService', () => {
  let service: ChatAttachmentsService;
  let conversations: {
    assertParticipant: jest.Mock;
    sendWithAttachment: jest.Mock;
  };
  let prisma: { message: { findFirst: jest.Mock } };
  let serviceBucket: { upload: jest.Mock; remove: jest.Mock };
  let userBucket: { createSignedUrl: jest.Mock };
  let fromService: jest.Mock;
  let tokenUsado: string | undefined;

  beforeEach(() => {
    conversations = {
      assertParticipant: jest.fn().mockResolvedValue(undefined),
      sendWithAttachment: jest.fn().mockResolvedValue(ENVIADO),
    };
    prisma = { message: { findFirst: jest.fn() } };
    serviceBucket = {
      upload: jest.fn().mockResolvedValue({ error: null }),
      remove: jest.fn().mockResolvedValue({ error: null }),
    };
    userBucket = {
      createSignedUrl: jest.fn().mockResolvedValue({
        data: { signedUrl: 'https://storage/firmada' },
        error: null,
      }),
    };
    fromService = jest.fn().mockReturnValue(serviceBucket);
    tokenUsado = undefined;
    const supabase = {
      getServiceClient: () => ({ storage: { from: fromService } }),
      getClientForToken: (token: string) => {
        tokenUsado = token;
        return { storage: { from: () => userBucket } };
      },
    } as unknown as SupabaseService;

    service = new ChatAttachmentsService(
      prisma as unknown as PrismaService,
      supabase,
      conversations as unknown as ConversationsService,
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const archivo = (buffer: Buffer, mimetype: string) => ({
    buffer,
    mimetype,
    size: buffer.length,
  });

  describe('send', () => {
    it('sube el archivo a la carpeta de la conversación, con nombre aleatorio, y manda el mensaje', async () => {
      const mensaje = await service.send(
        USER,
        CONVERSATION,
        archivo(PDF, 'application/pdf'),
        '  El estudio  ',
      );

      expect(fromService).toHaveBeenCalledWith(CHAT_ATTACHMENTS_BUCKET);
      const [path, body, opts] = serviceBucket.upload.mock.calls[0] as [
        string,
        Buffer,
        { contentType: string; upsert: boolean },
      ];
      expect(path).toMatch(new RegExp(`^${CONVERSATION}/[0-9a-f-]{36}\\.pdf$`));
      expect(body).toBe(PDF);
      expect(opts).toEqual({ contentType: 'application/pdf', upsert: false });
      expect(conversations.sendWithAttachment).toHaveBeenCalledWith(
        USER,
        CONVERSATION,
        {
          path,
          mime: 'application/pdf',
          size: PDF.length,
          content: 'El estudio',
        },
        expect.any(Date),
      );
      expect(mensaje).toBe(ENVIADO);
    });

    it('sin texto, el mensaje va solo con el archivo', async () => {
      await service.send(USER, CONVERSATION, archivo(PNG, 'image/png'), '   ');

      expect(conversations.sendWithAttachment.mock.calls[0][2]).toMatchObject({
        mime: 'image/png',
        content: null,
      });
    });

    it.each([
      [
        'un ejecutable que dice ser PDF',
        Buffer.from('MZ\x90\x00'),
        'application/pdf',
      ],
      ['un tipo no aceptado', Buffer.from('GIF89a'), 'image/gif'],
      ['un PNG declarado como JPG', PNG, 'image/jpeg'],
    ])('rechaza %s sin subir nada', async (_caso, buffer, mime) => {
      await expect(
        service.send(USER, CONVERSATION, archivo(buffer, mime), undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(serviceBucket.upload).not.toHaveBeenCalled();
    });

    it('rechaza un archivo vacío y uno de más de 10 MB', async () => {
      await expect(
        service.send(
          USER,
          CONVERSATION,
          archivo(Buffer.alloc(0), 'application/pdf'),
          undefined,
        ),
      ).rejects.toThrow('El archivo está vacío.');

      const grande = Buffer.alloc(10 * 1024 * 1024 + 1);
      PDF.copy(grande);
      await expect(
        service.send(
          USER,
          CONVERSATION,
          archivo(grande, 'application/pdf'),
          undefined,
        ),
      ).rejects.toThrow('El archivo no puede pasar los 10 MB.');
      expect(serviceBucket.upload).not.toHaveBeenCalled();
    });

    it('en una conversación ajena no sube nada: el 404 sale antes', async () => {
      conversations.assertParticipant.mockRejectedValue(
        new NotFoundException('Esa conversación no existe.'),
      );

      await expect(
        service.send(
          USER,
          CONVERSATION,
          archivo(PDF, 'application/pdf'),
          undefined,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(serviceBucket.upload).not.toHaveBeenCalled();
    });

    it('si Storage falla, da 500 sin crear el mensaje', async () => {
      serviceBucket.upload.mockResolvedValue({ error: { message: 'caído' } });

      await expect(
        service.send(
          USER,
          CONVERSATION,
          archivo(PDF, 'application/pdf'),
          undefined,
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(conversations.sendWithAttachment).not.toHaveBeenCalled();
    });

    it('si no se puede guardar el mensaje, borra el archivo: sin fila nadie lo puede abrir', async () => {
      conversations.sendWithAttachment.mockRejectedValue(
        new Error('la base no responde'),
      );

      await expect(
        service.send(
          USER,
          CONVERSATION,
          archivo(PDF, 'application/pdf'),
          undefined,
        ),
      ).rejects.toThrow('la base no responde');
      const [path] = serviceBucket.upload.mock.calls[0] as [string];
      expect(serviceBucket.remove).toHaveBeenCalledWith([path]);
    });
  });

  describe('url', () => {
    it('firma el archivo por cinco minutos con el token de quien pide', async () => {
      prisma.message.findFirst.mockResolvedValue({
        attachment_url: `${CONVERSATION}/archivo.pdf`,
      });

      const res = await service.url(
        USER,
        'token-del-usuario',
        CONVERSATION,
        MESSAGE,
      );

      expect(tokenUsado).toBe('token-del-usuario');
      expect(userBucket.createSignedUrl).toHaveBeenCalledWith(
        `${CONVERSATION}/archivo.pdf`,
        ATTACHMENT_URL_TTL_SECONDS,
      );
      expect(res.url).toBe('https://storage/firmada');
      expect(prisma.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: MESSAGE,
            conversation_id: CONVERSATION,
            attachment_url: { not: null },
          },
        }),
      );
    });

    it('un mensaje sin archivo, de otra conversación o inexistente da 404', async () => {
      prisma.message.findFirst.mockResolvedValue(null);

      await expect(
        service.url(USER, 'token', CONVERSATION, MESSAGE),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(userBucket.createSignedUrl).not.toHaveBeenCalled();
    });

    it('en una conversación ajena da 404 sin mirar el mensaje', async () => {
      conversations.assertParticipant.mockRejectedValue(
        new NotFoundException('Esa conversación no existe.'),
      );

      await expect(
        service.url(USER, 'token', CONVERSATION, MESSAGE),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.message.findFirst).not.toHaveBeenCalled();
    });

    it('si Storage no firma, da 500', async () => {
      prisma.message.findFirst.mockResolvedValue({ attachment_url: 'x/y.pdf' });
      userBucket.createSignedUrl.mockResolvedValue({
        data: null,
        error: { message: 'no' },
      });

      await expect(
        service.url(USER, 'token', CONVERSATION, MESSAGE),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });
});
