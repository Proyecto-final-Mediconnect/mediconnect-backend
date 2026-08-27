import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';
import { DailyService } from './../src/video/daily.service';

/**
 * Videoconsulta desde un turno (ENG-56) a nivel HTTP, con la app real: guard,
 * `ParseUUIDPipe` del path y ThrottlerGuard global.
 *
 * `DailyService` y el cliente de Supabase van mockeados. Lo que se verifica acá
 * es el borde: quién llega al handler, qué códigos salen y —lo más importante—
 * que ninguna petición rechazada haya llegado a crear una sala, porque crear
 * salas cuesta minutos facturables. Las reglas de negocio están en
 * `video-consultation.service.spec.ts`.
 */
const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const APPOINTMENT = '44444444-4444-4444-8444-444444444444';
const SCHEDULED_AT = '2026-08-27T15:00:00.000Z';

describe('Videoconsulta desde un turno (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let daily: {
    createConsultationRoom: jest.Mock;
    createConsultationToken: jest.Mock;
    deleteRoom: jest.Mock;
    isConfigured: jest.Mock;
  };
  let appointmentRow: Record<string, unknown> | null;

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    // El turno arranca dentro de la ventana de ingreso para todos los casos que
    // esperan éxito; los que no, se apoyan en el estado o en la ausencia de fila.
    appointmentRow = {
      id: APPOINTMENT,
      patient_id: PATIENT,
      professional_id: '22222222-2222-4222-8222-222222222222',
      scheduled_at: SCHEDULED_AT,
      duration_minutes: 30,
      status: 'RESERVADO_SIN_PAGAR',
    };

    daily = {
      createConsultationRoom: jest.fn().mockResolvedValue({
        name: 'consulta-abc123',
        url: 'https://mediconnect.daily.co/consulta-abc123',
      }),
      createConsultationToken: jest.fn().mockResolvedValue('tok'),
      deleteRoom: jest.fn().mockResolvedValue(undefined),
      isConfigured: jest.fn().mockReturnValue(true),
    };

    const supabase = {
      getClient: () => ({ from: () => ({}), auth: {} }),
      getClientForToken: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: appointmentRow, error: null }),
            }),
          }),
        }),
      }),
      getJWKS: () => publicKey,
      getIssuer: () => ISSUER,
    };

    const prisma = {
      profile: { findUnique: jest.fn() },
      consultation: { upsert: jest.fn().mockResolvedValue({ id: 'cons-1' }) },
      videoSession: {
        upsert: jest.fn().mockResolvedValue({
          id: 'vs-1',
          daily_room_name: null,
          daily_room_url: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      professional: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ first_name: 'Ana', last_name: 'Gómez' }),
      },
      patient: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabase)
      .overrideProvider(PrismaService)
      .useValue(prisma)
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

    // La ventana de ingreso se evalúa contra el reloj real del service, así que
    // se congela el tiempo dentro de la ventana del turno (15:00 ± tolerancia).
    jest.useFakeTimers({
      now: new Date('2026-08-27T14:55:00.000Z'),
      doNotFake: ['setTimeout', 'setInterval', 'nextTick', 'setImmediate'],
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await app.close();
  });

  function signToken(sub: string = PATIENT): Promise<string> {
    return new SignJWT({ email: 'paciente@test.com', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  const url = (id: string = APPOINTMENT) => `/appointments/${id}/video`;

  it('sin token devuelve 401 y no crea ninguna sala', async () => {
    // Que el guard corra ANTES que cualquier llamada a Daily es parte del punto:
    // un endpoint abierto que crea salas es una factura abierta.
    await request(app.getHttpServer()).post(url()).expect(401);

    expect(daily.createConsultationRoom).not.toHaveBeenCalled();
  });

  it('con un id que no es UUID devuelve 400 sin tocar Daily', async () => {
    await request(app.getHttpServer())
      .post(url('no-es-un-uuid'))
      .set('Authorization', `Bearer ${await signToken()}`)
      .expect(400);

    expect(daily.createConsultationRoom).not.toHaveBeenCalled();
  });

  it('devuelve 200 con la URL tokenizada y el rol', async () => {
    const res = await request(app.getHttpServer())
      .post(url())
      .set('Authorization', `Bearer ${await signToken()}`)
      .expect(200);

    expect(res.body).toMatchObject({
      appointmentId: APPOINTMENT,
      role: 'PACIENTE',
      roomUrl: 'https://mediconnect.daily.co/consulta-abc123?t=tok',
      expiresAt: '2026-08-27T15:45:00.000Z',
      recording: { enabled: false, mode: 'off' },
    });
  });

  it('el meeting token nunca se persiste ni se devuelve suelto', async () => {
    // Solo viaja dentro de `roomUrl`: si apareciera como campo propio invitaría a
    // guardarlo, y es una credencial de acceso a una consulta médica.
    const res = await request(app.getHttpServer())
      .post(url())
      .set('Authorization', `Bearer ${await signToken()}`)
      .expect(200);

    expect(Object.keys(res.body as object)).not.toContain('token');
  });

  it('un turno que RLS no devuelve da 404', async () => {
    appointmentRow = null;

    await request(app.getHttpServer())
      .post(url())
      .set('Authorization', `Bearer ${await signToken()}`)
      .expect(404);

    expect(daily.createConsultationRoom).not.toHaveBeenCalled();
  });

  it('un turno cancelado da 409', async () => {
    appointmentRow = { ...appointmentRow, status: 'CANCELADO' };

    await request(app.getHttpServer())
      .post(url())
      .set('Authorization', `Bearer ${await signToken()}`)
      .expect(409);

    expect(daily.createConsultationRoom).not.toHaveBeenCalled();
  });

  it('fuera de la ventana da 409 y no gasta una sala', async () => {
    jest.setSystemTime(new Date('2026-08-27T10:00:00.000Z'));

    await request(app.getHttpServer())
      .post(url())
      .set('Authorization', `Bearer ${await signToken()}`)
      .expect(409);

    expect(daily.createConsultationRoom).not.toHaveBeenCalled();
  });
});
