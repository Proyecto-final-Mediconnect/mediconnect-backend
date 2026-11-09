import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { legalAcceptedPrismaMock } from './legal-accepted.mock';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';

/**
 * Reseñas a nivel HTTP (ENG-80, ENG-81, ENG-82), con la app real: guard,
 * `ValidationPipe` y que el listado del perfil sea público. Las reglas están
 * en el spec del service.
 */
const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const MOD = '33333333-3333-4333-8333-333333333333';
const TURNO = '44444444-4444-4444-8444-444444444444';
const RESENA = '55555555-5555-4555-8555-555555555555';
const CREATED = new Date('2026-11-01T15:00:00.000Z');

describe('Reseñas (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let prisma: {
    appointment: { findUnique: jest.Mock; findMany: jest.Mock };
    reviewPromptDismissal: { upsert: jest.Mock };
    review: {
      create: jest.Mock;
      findMany: jest.Mock;
      groupBy: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    profile: { findUnique: jest.Mock };
    reviewResponse: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
    };
    auditLog: { create: jest.Mock };
    notification: { create: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    prisma = {
      appointment: {
        findUnique: jest.fn().mockResolvedValue({
          patient_id: PATIENT,
          professional_id: PRO,
          status: 'COMPLETADO',
          review: null,
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      reviewPromptDismissal: { upsert: jest.fn().mockResolvedValue({}) },
      review: {
        create: jest.fn().mockResolvedValue({
          id: RESENA,
          appointment_id: TURNO,
          professional_id: PRO,
          rating: 5,
          comment: null,
          status: 'PENDIENTE_MODERACION',
          moderation_reason: null,
          created_at: CREATED,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ id: RESENA }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: RESENA,
          rating: 2,
          comment: 'x',
          status: 'RECHAZADA',
          created_at: CREATED,
          moderation_reason: 'Insultos',
          moderated_at: CREATED,
          patient: { first_name: 'Marina', last_name: 'López' },
          professional: {
            profile_id: PRO,
            first_name: 'Ana',
            last_name: 'García',
          },
          appointment_id: TURNO,
          patient_id: PATIENT,
        }),
      },
      profile: {
        findUnique: jest.fn().mockResolvedValue({ role: 'MODERADOR' }),
      },
      reviewResponse: {
        upsert: jest.fn().mockResolvedValue({
          review_id: RESENA,
          content: 'Gracias.',
          created_at: CREATED,
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({ content: 'Gracias.' }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };
    // respond() y deleteResponse() corren en una transacción interactiva.
    prisma.$transaction.mockImplementation(
      (cb: (tx: typeof prisma) => unknown) => cb(prisma),
    );

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        getClient: () => ({ from: () => ({}), auth: {} }),
        getJWKS: () => publicKey,
        getIssuer: () => ISSUER,
      })
      .overrideProvider(PrismaService)
      .useValue({ ...legalAcceptedPrismaMock(), ...prisma })
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

  function signToken(sub: string): Promise<string> {
    return new SignJWT({
      email: 'x@test.com',
      role: 'authenticated',
      aal: 'aal2',
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  it('dejar una reseña sin sesión da 401', async () => {
    await request(app.getHttpServer())
      .post(`/appointments/${TURNO}/review`)
      .send({ rating: 5 })
      .expect(401);
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it('deja una reseña y devuelve 201 pendiente de moderación', async () => {
    const res = await request(app.getHttpServer())
      .post(`/appointments/${TURNO}/review`)
      .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
      .send({ rating: 5, comment: '  ' })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'PENDIENTE_MODERACION' });
    // Un comentario en blanco no se guarda como "".
    expect(prisma.review.create.mock.calls[0][0].data.comment).toBeNull();
  });

  describe('pedido de reseña (ENG-190)', () => {
    it('las pendientes piden sesión', async () => {
      await request(app.getHttpServer()).get('/reviews/pending').expect(401);
    });

    it('devuelve las pendientes del paciente', async () => {
      const res = await request(app.getHttpServer())
        .get('/reviews/pending')
        .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('descartar devuelve 204 y guarda el descarte', async () => {
      await request(app.getHttpServer())
        .post(`/reviews/pending/${TURNO}/dismiss`)
        .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
        .expect(204);
      expect(prisma.reviewPromptDismissal.upsert).toHaveBeenCalled();
    });

    it('descartar un turno ajeno da 404', async () => {
      await request(app.getHttpServer())
        .post(`/reviews/pending/${TURNO}/dismiss`)
        .set('Authorization', `Bearer ${await signToken(PRO)}`)
        .expect(404);
      expect(prisma.reviewPromptDismissal.upsert).not.toHaveBeenCalled();
    });
  });

  it('una calificación fuera de 1 a 5 da 400', async () => {
    await request(app.getHttpServer())
      .post(`/appointments/${TURNO}/review`)
      .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
      .send({ rating: 6 })
      .expect(400);
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it('las reseñas de un profesional son públicas', async () => {
    const res = await request(app.getHttpServer())
      .get(`/professionals/${PRO}/reviews`)
      .expect(200);
    expect(res.body).toEqual({
      reviews: [],
      rating: null,
      page: 1,
      hasMore: false,
    });
  });

  it('rechazar sin motivo da 400 y no toca nada', async () => {
    await request(app.getHttpServer())
      .patch(`/moderation/reviews/${RESENA}`)
      .set('Authorization', `Bearer ${await signToken(MOD)}`)
      .send({ decision: 'RECHAZADA' })
      .expect(400);
    expect(prisma.review.updateMany).not.toHaveBeenCalled();
  });

  it('rechazar con motivo devuelve la reseña moderada', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/moderation/reviews/${RESENA}`)
      .set('Authorization', `Bearer ${await signToken(MOD)}`)
      .send({ decision: 'RECHAZADA', reason: 'Insultos' })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'RECHAZADA',
      moderationReason: 'Insultos',
    });
  });

  it('un paciente no ve la cola de moderación', async () => {
    prisma.profile.findUnique.mockResolvedValue({ role: 'PACIENTE' });
    await request(app.getHttpServer())
      .get('/moderation/reviews')
      .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
      .expect(403);
  });

  it('un comentario con insultos da 422 con un mensaje para reformularlo (ENG-107)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/appointments/${TURNO}/review`)
      .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
      .send({ rating: 1, comment: 'Un b0lud0 total' })
      .expect(422);

    expect(res.body.message).toMatch(/Reformulalo/);
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  describe('respuestas del profesional (ENG-106)', () => {
    beforeEach(() => {
      prisma.profile.findUnique.mockResolvedValue({ role: 'PROFESIONAL' });
      prisma.review.findUnique.mockResolvedValue({
        professional_id: PRO,
        status: 'APROBADA',
      });
    });

    it('sin sesión no se responde ni se borra', async () => {
      await request(app.getHttpServer())
        .put(`/reviews/${RESENA}/response`)
        .send({ content: 'Gracias.' })
        .expect(401);
      await request(app.getHttpServer())
        .delete(`/reviews/${RESENA}/response`)
        .expect(401);
      expect(prisma.reviewResponse.upsert).not.toHaveBeenCalled();
    });

    it('responde y devuelve la respuesta', async () => {
      const res = await request(app.getHttpServer())
        .put(`/reviews/${RESENA}/response`)
        .set('Authorization', `Bearer ${await signToken(PRO)}`)
        .send({ content: '  Gracias.  ' })
        .expect(200);

      expect(res.body).toEqual({
        reviewId: RESENA,
        content: 'Gracias.',
        createdAt: CREATED.toISOString(),
      });
      expect(prisma.reviewResponse.upsert.mock.calls[0][0].create.content).toBe(
        'Gracias.',
      );
    });

    it('una respuesta vacía o de más de 1000 caracteres da 400', async () => {
      const token = await signToken(PRO);
      for (const content of ['   ', 'a'.repeat(1001)]) {
        await request(app.getHttpServer())
          .put(`/reviews/${RESENA}/response`)
          .set('Authorization', `Bearer ${token}`)
          .send({ content })
          .expect(400);
      }
      expect(prisma.reviewResponse.upsert).not.toHaveBeenCalled();
    });

    it('borra la respuesta con 204', async () => {
      await request(app.getHttpServer())
        .delete(`/reviews/${RESENA}/response`)
        .set('Authorization', `Bearer ${await signToken(PRO)}`)
        .expect(204);
    });

    it('las reseñas recibidas son solo para profesionales', async () => {
      await request(app.getHttpServer())
        .get('/reviews/received')
        .set('Authorization', `Bearer ${await signToken(PRO)}`)
        .expect(200);

      prisma.profile.findUnique.mockResolvedValue({ role: 'PACIENTE' });
      await request(app.getHttpServer())
        .get('/reviews/received')
        .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
        .expect(403);
    });
  });
});
