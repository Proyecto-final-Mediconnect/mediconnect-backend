import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';
import { legalAcceptedPrismaMock } from './legal-accepted.mock';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const SUB = '11111111-1111-4111-8111-111111111111';
const PRO_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

/**
 * La superficie HTTP del chat (ENG-70).
 *
 * Lo que vive en el controller y en los pipes: que todo esté detrás de sesión,
 * que la validación corte antes de tocar la base, y la forma del token de
 * Realtime que consume la web. Las reglas de quién habla con quién están en el
 * spec del service; el aislamiento por RLS, en el de integración.
 */
describe('Conversations (e2e)', () => {
  let app: INestApplication<App>;
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;

  const profileFindUnique = jest.fn();
  const conversationFindFirst = jest.fn();
  const messageCreate = jest.fn();
  const notificationCount = jest.fn();
  const notificationCreate = jest.fn();
  const messageFindFirst = jest.fn();
  /** Storage del chat (ENG-102): lo que sube el backend y lo que firma con el token del usuario. */
  const storageUpload = jest.fn();
  const storageRemove = jest.fn();
  const storageSign = jest.fn();
  let tokenFirmante: string | undefined;

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    [
      profileFindUnique,
      conversationFindFirst,
      messageCreate,
      notificationCount,
      notificationCreate,
      messageFindFirst,
      storageUpload,
      storageRemove,
      storageSign,
    ].forEach((fn) => fn.mockReset());
    storageUpload.mockResolvedValue({ error: null });
    storageRemove.mockResolvedValue({ error: null });
    storageSign.mockResolvedValue({
      data: { signedUrl: 'https://storage.test/firmada' },
      error: null,
    });
    tokenFirmante = undefined;

    profileFindUnique.mockResolvedValue({ role: 'PACIENTE' });
    notificationCount.mockResolvedValue(0);
    notificationCreate.mockResolvedValue({});

    const prismaMock = {
      ...legalAcceptedPrismaMock(),
      profile: { findUnique: profileFindUnique },
      conversation: {
        findFirst: conversationFindFirst,
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      message: { create: messageCreate, findFirst: messageFindFirst },
      patient: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ first_name: 'Julián', last_name: 'Pérez' }),
      },
      notification: { count: notificationCount, create: notificationCreate },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        getClient: () => ({ auth: {} }),
        getServiceClient: () => ({
          storage: {
            from: () => ({ upload: storageUpload, remove: storageRemove }),
          },
        }),
        getClientForToken: (token: string) => {
          tokenFirmante = token;
          return {
            storage: { from: () => ({ createSignedUrl: storageSign }) },
          };
        },
        getJWKS: () => publicKey,
        getIssuer: () => ISSUER,
      })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  function signToken(): Promise<string> {
    return new SignJWT({ email: 'paciente@test.com', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(SUB)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  it('sin sesión, ninguna ruta del chat responde', async () => {
    const server = app.getHttpServer();
    await request(server).get('/conversations/me').expect(401);
    await request(server).get('/conversations/realtime-token').expect(401);
    await request(server)
      .post('/conversations')
      .send({ contraparteId: PRO_ID })
      .expect(401);
    await request(server)
      .get(`/conversations/${CONVERSATION_ID}/messages`)
      .expect(401);
    await request(server)
      .post(`/conversations/${CONVERSATION_ID}/messages`)
      .send({ contenido: 'hola' })
      .expect(401);
    await request(server)
      .patch(`/conversations/${CONVERSATION_ID}/read`)
      .expect(401);
    await request(server)
      .delete(`/conversations/${CONVERSATION_ID}`)
      .expect(401);
    expect(profileFindUnique).not.toHaveBeenCalled();
  });

  describe('GET /conversations/realtime-token', () => {
    it('devuelve el token de la cookie y cuándo vence, sin cachear', async () => {
      const token = await signToken();

      const res = await request(app.getHttpServer())
        .get('/conversations/realtime-token')
        .set('Cookie', `sb-access-token=${token}`)
        .expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.accessToken).toBe(token);
      const expira = new Date(res.body.expiraEl as string).getTime();
      expect(expira).toBeGreaterThan(Date.now() + 55 * 60_000);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'accessToken',
        'expiraEl',
      ]);
    });
  });

  describe('POST /conversations/:id/messages', () => {
    it('un mensaje vacío o solo con espacios da 400 sin tocar la base', async () => {
      const token = await signToken();

      for (const contenido of ['', '   ', 42]) {
        await request(app.getHttpServer())
          .post(`/conversations/${CONVERSATION_ID}/messages`)
          .set('Authorization', `Bearer ${token}`)
          .send({ contenido })
          .expect(400);
      }
      expect(conversationFindFirst).not.toHaveBeenCalled();
    });

    it('un mensaje de más de 2000 caracteres da 400', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .post(`/conversations/${CONVERSATION_ID}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ contenido: 'a'.repeat(2001) })
        .expect(400);
    });

    it('un id que no es UUID da 400', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .post('/conversations/no-es-uuid/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ contenido: 'hola' })
        .expect(400);
    });

    it('en una conversación ajena da 404', async () => {
      conversationFindFirst.mockResolvedValue(null);
      const token = await signToken();

      await request(app.getHttpServer())
        .post(`/conversations/${CONVERSATION_ID}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ contenido: 'hola' })
        .expect(404);
      expect(messageCreate).not.toHaveBeenCalled();
    });

    it('guarda el mensaje recortado y devuelve la forma que tipa la web', async () => {
      conversationFindFirst.mockResolvedValue({
        patient_id: SUB,
        professional_id: PRO_ID,
      });
      messageCreate.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => ({
          id: '44444444-4444-4444-8444-444444444444',
          conversation_id: data.conversation_id,
          sender_id: data.sender_id,
          content: data.content,
          created_at: data.created_at,
          read_at: null,
        }),
      );
      const token = await signToken();

      const res = await request(app.getHttpServer())
        .post(`/conversations/${CONVERSATION_ID}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ contenido: '  Hola, doctora  ' })
        .expect(201);

      expect(res.body).toEqual({
        id: '44444444-4444-4444-8444-444444444444',
        conversacionId: CONVERSATION_ID,
        autorId: SUB,
        contenido: 'Hola, doctora',
        enviadoEl: expect.any(String),
        leidoEl: null,
        adjunto: null,
      });
      expect(notificationCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          user_id: PRO_ID,
          type: 'NUEVO_MENSAJE',
          payload: { conversationId: CONVERSATION_ID, from: 'Julián Pérez' },
        }),
      });
    });
  });

  describe('POST /conversations', () => {
    it('sin contraparteId válido da 400', async () => {
      const token = await signToken();

      for (const body of [{}, { contraparteId: 'x' }]) {
        await request(app.getHttpServer())
          .post('/conversations')
          .set('Authorization', `Bearer ${token}`)
          .send(body)
          .expect(400);
      }
      expect(profileFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /conversations/:id', () => {
    it('un id que no es UUID da 400 sin tocar la base', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .delete('/conversations/no-es-uuid')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
      expect(conversationFindFirst).not.toHaveBeenCalled();
    });

    it('una conversación ajena da 404', async () => {
      conversationFindFirst.mockResolvedValue(null);
      const token = await signToken();

      await request(app.getHttpServer())
        .delete(`/conversations/${CONVERSATION_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  describe('GET /conversations/:id/messages', () => {
    it('un antesDe que no es UUID da 400', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .get(`/conversations/${CONVERSATION_ID}/messages?antesDe=nope`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
      expect(conversationFindFirst).not.toHaveBeenCalled();
    });
  });

  describe('Archivos en el chat (ENG-102)', () => {
    const PDF = Buffer.from('%PDF-1.7 estudio');
    const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';

    function participante() {
      conversationFindFirst.mockResolvedValue({
        patient_id: SUB,
        professional_id: PRO_ID,
      });
    }

    it('sin sesión no se manda ni se abre ningún archivo', async () => {
      const server = app.getHttpServer();
      await request(server)
        .post(`/conversations/${CONVERSATION_ID}/attachments`)
        .attach('file', PDF, {
          filename: 'estudio.pdf',
          contentType: 'application/pdf',
        })
        .expect(401);
      await request(server)
        .get(
          `/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}/attachment`,
        )
        .expect(401);
      expect(storageUpload).not.toHaveBeenCalled();
    });

    it('manda un PDF con texto: lo sube a la carpeta de la conversación y guarda el mensaje', async () => {
      participante();
      messageCreate.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: MESSAGE_ID,
            conversation_id: CONVERSATION_ID,
            sender_id: SUB,
            content: data.content,
            attachment_mime: data.attachment_mime,
            attachment_size: data.attachment_size,
            created_at: new Date('2026-11-04T12:00:00.000Z'),
            read_at: null,
          }),
      );

      const res = await request(app.getHttpServer())
        .post(`/conversations/${CONVERSATION_ID}/attachments`)
        .set('Authorization', `Bearer ${await signToken()}`)
        .field('contenido', 'El estudio que me pidió')
        .attach('file', PDF, {
          filename: 'resultado-VIH.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      expect(res.body).toMatchObject({
        id: MESSAGE_ID,
        contenido: 'El estudio que me pidió',
        adjunto: { tipo: 'application/pdf', tamano: PDF.length },
      });
      const [path] = storageUpload.mock.calls[0] as [string];
      // El nombre original no llega a Storage: puede decir más de lo que hace falta.
      expect(path).toMatch(
        new RegExp(`^${CONVERSATION_ID}/[0-9a-f-]{36}[.]pdf$`),
      );
      expect(path).not.toContain('VIH');
      const { data } = messageCreate.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        attachment_url: path,
        attachment_mime: 'application/pdf',
        attachment_size: PDF.length,
      });
    });

    it('sin archivo da 400', async () => {
      participante();

      await request(app.getHttpServer())
        .post(`/conversations/${CONVERSATION_ID}/attachments`)
        .set('Authorization', `Bearer ${await signToken()}`)
        .field('contenido', 'hola')
        .expect(400);
    });

    it('un ejecutable con extensión .pdf da 400 y no llega a Storage', async () => {
      participante();

      await request(app.getHttpServer())
        .post(`/conversations/${CONVERSATION_ID}/attachments`)
        .set('Authorization', `Bearer ${await signToken()}`)
        .attach('file', Buffer.from([0x4d, 0x5a, 0x90, 0x00]), {
          filename: 'receta.pdf',
          contentType: 'application/pdf',
        })
        .expect(400);
      expect(storageUpload).not.toHaveBeenCalled();
    });

    it('en una conversación ajena da 404 y no sube nada', async () => {
      conversationFindFirst.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post(`/conversations/${CONVERSATION_ID}/attachments`)
        .set('Authorization', `Bearer ${await signToken()}`)
        .attach('file', PDF, {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        })
        .expect(404);
      expect(storageUpload).not.toHaveBeenCalled();
    });

    it('abre el archivo con una URL firmada con el token de quien pide, sin cachear', async () => {
      participante();
      messageFindFirst.mockResolvedValue({
        attachment_url: `${CONVERSATION_ID}/archivo.pdf`,
      });
      const token = await signToken();

      const res = await request(app.getHttpServer())
        .get(
          `/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}/attachment`,
        )
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.url).toBe('https://storage.test/firmada');
      expect(tokenFirmante).toBe(token);
    });

    it('un mensaje sin archivo da 404', async () => {
      participante();
      messageFindFirst.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get(
          `/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}/attachment`,
        )
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(404);
      expect(storageSign).not.toHaveBeenCalled();
    });
  });
});
