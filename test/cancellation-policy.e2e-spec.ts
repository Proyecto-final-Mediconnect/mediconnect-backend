import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DEFAULT_CANCELLATION_POLICY } from './../src/professionals/cancellation-policy';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';
import { legalAcceptedPrismaMock } from './legal-accepted.mock';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const SUB = '22222222-2222-4222-8222-222222222222';

/**
 * Política de cancelación (ENG-67) a nivel HTTP, con la app real.
 *
 * Los unit tests del service no pueden cubrir esto: **los rangos del DTO los
 * aplica el `ValidationPipe` global**, no el service, así que un `@Max(720)` que
 * no esté bien cableado pasaría desapercibido. Acá entra por el pipe de verdad.
 *
 * El cliente de Supabase va mockeado porque no hay forma de tenerlo en local;
 * estas rutas igual no lo usan, leen y escriben por Prisma.
 */
describe('Política de cancelación (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  let prismaMock: {
    profile: { findUnique: jest.Mock };
    professional: { findUnique: jest.Mock };
    cancellationPolicy: { findUnique: jest.Mock; upsert: jest.Mock };
    legalAcceptance: { findUnique: jest.Mock };
  };

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    prismaMock = {
      profile: { findUnique: jest.fn() },
      professional: {
        findUnique: jest.fn().mockResolvedValue({ profile_id: SUB }),
      },
      cancellationPolicy: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      ...legalAcceptedPrismaMock(),
    };

    const supabase = {
      getClient: () => ({ from: () => ({}) }),
      getClientForToken: () => ({ from: () => ({}) }),
      getJWKS: () => publicKey,
      getIssuer: () => ISSUER,
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabase)
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
    return new SignJWT({ email: 'pro@test.com', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(SUB)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  const cuerpo = {
    hoursFullRefund: 48,
    hoursPartialRefund: 12,
    partialRefundPercent: 30,
  };

  describe('GET /professionals/me/cancellation-policy', () => {
    it('sin sesión es 401', async () => {
      await request(app.getHttpServer())
        .get('/professionals/me/cancellation-policy')
        .expect(401);
    });

    it('sin política configurada devuelve el default', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .get('/professionals/me/cancellation-policy')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect({ ...DEFAULT_CANCELLATION_POLICY, configured: false });
    });

    it('`me` no se interpreta como un id de profesional', async () => {
      // `ProfessionalsController` se registra antes que el público, que tiene
      // `GET /professionals/:id`. Si el orden se invirtiera, esta ruta caería
      // en el perfil público con id "me".
      const token = await signToken();

      const res = await request(app.getHttpServer())
        .get('/professionals/me/cancellation-policy')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toHaveProperty('configured');
    });
  });

  describe('PUT /professionals/me/cancellation-policy', () => {
    it('guarda una política válida', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .put('/professionals/me/cancellation-policy')
        .set('Authorization', `Bearer ${token}`)
        .send(cuerpo)
        .expect(200)
        .expect({ ...cuerpo, configured: true });

      expect(prismaMock.cancellationPolicy.upsert).toHaveBeenCalledTimes(1);
    });

    describe('el ValidationPipe rechaza', () => {
      it.each([
        ['un porcentaje mayor a 100', { partialRefundPercent: 150 }],
        ['un porcentaje negativo', { partialRefundPercent: -1 }],
        ['horas negativas', { hoursFullRefund: -5 }],
        ['horas por encima del tope de 720', { hoursFullRefund: 5000 }],
        ['horas con decimales', { hoursFullRefund: 12.5 }],
        ['un valor que no es número', { hoursFullRefund: 'muchas' }],
      ])('%s', async (_caso, parcial) => {
        const token = await signToken();

        await request(app.getHttpServer())
          .put('/professionals/me/cancellation-policy')
          .set('Authorization', `Bearer ${token}`)
          .send({ ...cuerpo, ...parcial })
          .expect(400);

        expect(prismaMock.cancellationPolicy.upsert).not.toHaveBeenCalled();
      });

      it.each([
        'hoursFullRefund',
        'hoursPartialRefund',
        'partialRefundPercent',
      ])('un cuerpo sin %s: los tres son obligatorios', async (campo) => {
        // A diferencia del PATCH del perfil, que es parcial a propósito: una
        // política a medias no se puede evaluar.
        const token = await signToken();
        const incompleto: Record<string, unknown> = { ...cuerpo };
        delete incompleto[campo];

        await request(app.getHttpServer())
          .put('/professionals/me/cancellation-policy')
          .set('Authorization', `Bearer ${token}`)
          .send(incompleto)
          .expect(400);
      });

      it('un campo de más (whitelist)', async () => {
        const token = await signToken();

        await request(app.getHttpServer())
          .put('/professionals/me/cancellation-policy')
          .set('Authorization', `Bearer ${token}`)
          .send({ ...cuerpo, hoursNoRefund: 1 })
          .expect(400);
      });
    });

    it('la ventana parcial más lejos que la total es 400 del service', async () => {
      // Esta no la puede ver un decorador por campo: es la relación entre los
      // dos plazos.
      const token = await signToken();

      const res = await request(app.getHttpServer())
        .put('/professionals/me/cancellation-policy')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...cuerpo, hoursFullRefund: 6, hoursPartialRefund: 24 })
        .expect(400);

      expect(res.body.message).toMatch(/más lejos/);
      expect(prismaMock.cancellationPolicy.upsert).not.toHaveBeenCalled();
    });

    it('un paciente recibe 409 y no escribe nada', async () => {
      prismaMock.professional.findUnique.mockResolvedValue(null);
      const token = await signToken();

      await request(app.getHttpServer())
        .put('/professionals/me/cancellation-policy')
        .set('Authorization', `Bearer ${token}`)
        .send(cuerpo)
        .expect(409);

      expect(prismaMock.cancellationPolicy.upsert).not.toHaveBeenCalled();
    });

    it('acepta los extremos del porcentaje', async () => {
      const token = await signToken();

      for (const partialRefundPercent of [0, 100]) {
        await request(app.getHttpServer())
          .put('/professionals/me/cancellation-policy')
          .set('Authorization', `Bearer ${token}`)
          .send({ ...cuerpo, partialRefundPercent })
          .expect(200);
      }
    });
  });
});
