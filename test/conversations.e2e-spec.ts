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
    ].forEach((fn) => fn.mockReset());

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
      message: { create: messageCreate },
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
});
