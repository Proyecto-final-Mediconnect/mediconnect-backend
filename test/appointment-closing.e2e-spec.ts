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
 * Cierre del turno por el profesional (ENG-189) a nivel HTTP: guard,
 * `ParseUUIDPipe` y los códigos que ve la web. Las reglas de ventana y estado
 * están en `appointment-closing.service.spec.ts`; el job, en
 * `appointment-closing.integration.spec.ts`.
 */
const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';
const APPOINTMENT = '44444444-4444-4444-8444-444444444444';

describe('Cierre del turno (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let appointmentRow: Record<string, unknown> | null;
  let appointmentUpdate: jest.Mock;
  let auditCreate: jest.Mock;

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    appointmentRow = {
      id: APPOINTMENT,
      patient_id: PATIENT,
      professional_id: PROFESSIONAL,
      scheduled_at: '2026-11-20T15:00:00.000Z',
      duration_minutes: 30,
      status: 'CONFIRMADO',
      created_at: '2026-11-10T12:00:00.000Z',
    };
    appointmentUpdate = jest.fn().mockResolvedValue({});
    auditCreate = jest.fn().mockResolvedValue({});

    const tx = {
      appointment: { update: appointmentUpdate },
      consultation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      videoSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: auditCreate },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
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
      })
      .overrideProvider(PrismaService)
      .useValue({
        profile: { findUnique: jest.fn() },
        ...legalAcceptedPrismaMock(),
        $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
      })
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

    // Las ventanas se evalúan contra el reloj real del service: se congela a
    // los 20 minutos del turno, dentro de las dos.
    jest.useFakeTimers({
      now: new Date('2026-11-20T15:20:00.000Z'),
      doNotFake: ['setTimeout', 'setInterval', 'nextTick', 'setImmediate'],
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await app.close();
  });

  function signToken(sub: string): Promise<string> {
    return new SignJWT({
      email: 'user@test.com',
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

  const url = (action: 'complete' | 'no-show', id: string = APPOINTMENT) =>
    `/appointments/${id}/${action}`;

  it('sin token devuelve 401 y no escribe nada', async () => {
    await request(app.getHttpServer()).patch(url('complete')).expect(401);
    expect(appointmentUpdate).not.toHaveBeenCalled();
  });

  it('con un id que no es UUID devuelve 400', async () => {
    await request(app.getHttpServer())
      .patch(url('complete', 'no-es-un-uuid'))
      .set('Authorization', `Bearer ${await signToken(PROFESSIONAL)}`)
      .expect(400);
  });

  it('el profesional completa el turno: 200 con el estado nuevo, auditado', async () => {
    const res = await request(app.getHttpServer())
      .patch(url('complete'))
      .set('Authorization', `Bearer ${await signToken(PROFESSIONAL)}`)
      .expect(200);

    expect(res.body).toEqual({ id: APPOINTMENT, status: 'COMPLETADO' });
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('el profesional marca no asistió: 200', async () => {
    const res = await request(app.getHttpServer())
      .patch(url('no-show'))
      .set('Authorization', `Bearer ${await signToken(PROFESSIONAL)}`)
      .expect(200);

    expect(res.body).toEqual({ id: APPOINTMENT, status: 'NO_ASISTIO' });
  });

  it('el paciente recibe 403 en las dos rutas', async () => {
    const token = await signToken(PATIENT);
    for (const action of ['complete', 'no-show'] as const) {
      await request(app.getHttpServer())
        .patch(url(action))
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    }
    expect(appointmentUpdate).not.toHaveBeenCalled();
  });

  it('un turno que RLS no muestra da 404', async () => {
    appointmentRow = null;
    await request(app.getHttpServer())
      .patch(url('complete'))
      .set('Authorization', `Bearer ${await signToken(PROFESSIONAL)}`)
      .expect(404);
  });

  it('un turno cancelado da 409', async () => {
    appointmentRow = { ...appointmentRow, status: 'CANCELADO' };
    await request(app.getHttpServer())
      .patch(url('no-show'))
      .set('Authorization', `Bearer ${await signToken(PROFESSIONAL)}`)
      .expect(409);
  });
});
