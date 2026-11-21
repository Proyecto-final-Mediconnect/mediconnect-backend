import {
  INestApplication,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { legalAcceptedPrismaMock } from './legal-accepted.mock';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';
import { DailyService } from './../src/video/daily.service';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const SUB = '11111111-1111-4111-8111-111111111111';

/**
 * La sala de prueba de cámara y micrófono a nivel HTTP, con la app real: guard
 * y ThrottlerGuard global. También que el banco de pruebas del spike de Daily
 * (ENG-51) ya no existe (ENG-151).
 *
 * `DailyService` va mockeado. Lo que se verifica acá es el borde HTTP; la
 * conversación con la API de Daily la cubre `daily.service.spec.ts`.
 */
describe('Sala de prueba de Daily.co (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let daily: {
    createConsultationRoom: jest.Mock;
    deleteRoom: jest.Mock;
    createTestRoom: jest.Mock;
    isConfigured: jest.Mock;
  };

  const SALA_DE_PRUEBA = {
    url: 'https://mediconnect.daily.co/prueba-0123456789ab?t=token',
    expiraEl: '2026-11-04T18:10:00.000Z',
  };

  function makeSupabaseMock() {
    return {
      getClient: () => ({ from: () => ({}), auth: {} }),
      getClientForToken: () => ({ from: () => ({}), auth: {} }),
      getJWKS: () => publicKey,
      getIssuer: () => ISSUER,
    };
  }

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    daily = {
      createConsultationRoom: jest.fn(),
      deleteRoom: jest.fn().mockResolvedValue(undefined),
      createTestRoom: jest.fn().mockResolvedValue(SALA_DE_PRUEBA),
      isConfigured: jest.fn().mockReturnValue(true),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(makeSupabaseMock())
      .overrideProvider(PrismaService)
      .useValue({
        profile: { findUnique: jest.fn() },
        ...legalAcceptedPrismaMock(),
      })
      .overrideProvider(DailyService)
      .useValue(daily)
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

  function signToken(sub = SUB): Promise<string> {
    return new SignJWT({
      email: 'pro@test.com',
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

  describe('el banco de pruebas del spike de Daily ya no existe (ENG-151)', () => {
    it.each([
      ['post', '/video/spike/rooms'],
      ['get', '/video/spike/rooms/spike-eng51-a1b2c3d4/sessions'],
      ['delete', '/video/spike/rooms/spike-eng51-a1b2c3d4'],
    ] as const)('%s %s da 404 y no toca Daily', async (method, path) => {
      await request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(404);

      expect(daily.createConsultationRoom).not.toHaveBeenCalled();
      expect(daily.createTestRoom).not.toHaveBeenCalled();
      expect(daily.deleteRoom).not.toHaveBeenCalled();
    });
  });

  describe('POST /video/test-room (probar cámara y micrófono)', () => {
    it('sin sesión devuelve 401 y no crea ninguna sala', async () => {
      await request(app.getHttpServer()).post('/video/test-room').expect(401);

      expect(daily.createTestRoom).not.toHaveBeenCalled();
    });

    it('con sesión devuelve la URL con el token, sin que nada la guarde en caché', async () => {
      const res = await request(app.getHttpServer())
        .post('/video/test-room')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(201);

      expect(res.body).toEqual(SALA_DE_PRUEBA);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(daily.createTestRoom).toHaveBeenCalledTimes(1);
    });

    it('sin Daily configurado devuelve el 503 explicado', async () => {
      daily.createTestRoom.mockRejectedValueOnce(
        new ServiceUnavailableException('falta DAILY_API_KEY'),
      );

      await request(app.getHttpServer())
        .post('/video/test-room')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(503);
    });

    it('corta al cuarto pedido del minuto: cada sala es una llamada que se factura', async () => {
      const token = await signToken();
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/video/test-room')
          .set('Authorization', `Bearer ${token}`)
          .expect(201);
      }

      await request(app.getHttpServer())
        .post('/video/test-room')
        .set('Authorization', `Bearer ${token}`)
        .expect(429);
      expect(daily.createTestRoom).toHaveBeenCalledTimes(3);
    });

    it('el cupo es por usuario: otro usuario en la misma IP no hereda el límite', async () => {
      const otro = '22222222-2222-4222-8222-222222222222';
      const ip = '190.12.34.56';
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/video/test-room')
          .set('CF-Connecting-IP', ip)
          .set('Authorization', `Bearer ${await signToken()}`)
          .expect(201);
      }

      await request(app.getHttpServer())
        .post('/video/test-room')
        .set('CF-Connecting-IP', ip)
        .set('Authorization', `Bearer ${await signToken(otro)}`)
        .expect(201);
      expect(daily.createTestRoom).toHaveBeenCalledTimes(4);
    });
  });
});
