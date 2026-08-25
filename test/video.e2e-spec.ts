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
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';
import { DailyService } from './../src/video/daily.service';
import { SPIKE_ROOM_PREFIX } from './../src/video/daily.config';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const SUB = '11111111-1111-4111-8111-111111111111';
const ROOM_NAME = `${SPIKE_ROOM_PREFIX}-a1b2c3d4`;

/**
 * Endpoints del spike de Daily (ENG-51) a nivel HTTP, con la app real: guard,
 * ThrottlerGuard global y el `SpikeRoomNamePipe` del path.
 *
 * `DailyService` va mockeado. Lo que se verifica acá es el borde HTTP (quién
 * puede entrar, qué nombres de sala se aceptan, qué códigos salen); la
 * conversación con la API de Daily la cubre `daily.service.spec.ts`, y la
 * llamada real quedó documentada en el informe del spike.
 */
describe('Spike de Daily.co (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let daily: {
    createSpikeRoom: jest.Mock;
    getMeetingSessions: jest.Mock;
    deleteRoom: jest.Mock;
    isConfigured: jest.Mock;
  };

  const ROOM = {
    name: ROOM_NAME,
    url: `https://mediconnect.daily.co/${ROOM_NAME}`,
    expiresAt: '2026-08-15T18:40:00.000Z',
    professionalUrl: `https://mediconnect.daily.co/${ROOM_NAME}?t=pro`,
    patientUrl: `https://mediconnect.daily.co/${ROOM_NAME}?t=pac`,
    maxParticipants: 2,
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
      createSpikeRoom: jest.fn().mockResolvedValue(ROOM),
      getMeetingSessions: jest.fn().mockResolvedValue([]),
      deleteRoom: jest.fn().mockResolvedValue(undefined),
      isConfigured: jest.fn().mockReturnValue(true),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(makeSupabaseMock())
      .overrideProvider(PrismaService)
      .useValue({ profile: { findUnique: jest.fn() } })
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

  describe('POST /video/spike/rooms', () => {
    it('sin token devuelve 401 y no crea ninguna sala', async () => {
      // Crear salas cuesta minutos facturables: que el guard corra ANTES que
      // cualquier llamada a Daily es parte del punto.
      await request(app.getHttpServer()).post('/video/spike/rooms').expect(401);

      expect(daily.createSpikeRoom).not.toHaveBeenCalled();
    });

    it('con token devuelve 201 con las dos URLs tokenizadas', async () => {
      const res = await request(app.getHttpServer())
        .post('/video/spike/rooms')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(201);

      expect(res.body).toEqual(ROOM);
      expect(daily.createSpikeRoom).toHaveBeenCalledTimes(1);
    });

    it('el 503 de "Daily no configurado" llega tal cual al cliente', async () => {
      daily.createSpikeRoom.mockRejectedValueOnce(
        new ServiceUnavailableException('falta DAILY_API_KEY'),
      );

      await request(app.getHttpServer())
        .post('/video/spike/rooms')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(503);
    });
  });

  describe('GET /video/spike/rooms/:name/sessions', () => {
    it('devuelve las sesiones de la sala', async () => {
      const session = {
        id: 's1',
        room: ROOM_NAME,
        startTime: '2026-08-15T18:00:00.000Z',
        durationSeconds: 1800,
        participants: 2,
        participantMinutes: 59,
      };
      daily.getMeetingSessions.mockResolvedValueOnce([session]);

      const res = await request(app.getHttpServer())
        .get(`/video/spike/rooms/${ROOM_NAME}/sessions`)
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(200);

      expect(res.body).toEqual([session]);
    });

    it('rechaza un nombre de sala ajeno al spike', async () => {
      await request(app.getHttpServer())
        .get('/video/spike/rooms/consulta-real/sessions')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(400);

      expect(daily.getMeetingSessions).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /video/spike/rooms/:name', () => {
    it('borra la sala del spike y devuelve 204', async () => {
      await request(app.getHttpServer())
        .delete(`/video/spike/rooms/${ROOM_NAME}`)
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(204);

      expect(daily.deleteRoom).toHaveBeenCalledWith(ROOM_NAME);
    });

    it('no deja borrar una sala que no creó el spike', async () => {
      await request(app.getHttpServer())
        .delete('/video/spike/rooms/consulta-real')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(400);

      expect(daily.deleteRoom).not.toHaveBeenCalled();
    });
  });
});
