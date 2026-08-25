import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const PRO_ID = '22222222-2222-4222-8222-222222222222';

/** Lunes 17/08/2026 a las 08:00 de Argentina. */
const MONDAY = '2026-08-17';
const NOW = new Date('2026-08-17T11:00:00Z');

/**
 * Disponibilidad y reserva de turnos (ENG-54) a nivel HTTP, con la app real:
 * guard, ValidationPipe global (`forbidNonWhitelisted`) y el `ParseUUIDPipe` del
 * path.
 *
 * Se mockean Prisma y el cliente de Supabase, igual que en `schedules.e2e-spec.ts`
 * y por el mismo motivo: no hay Postgres ni PostgREST en esta suite. Los GRANT y
 * las políticas RLS NO se verifican acá — con los clientes mockeados, por
 * construcción, estos tests no pueden fallar por permisos. Eso se validó aparte
 * contra Supabase real (ver descripción del PR).
 */
describe('Turnos (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let results: { data: unknown; error: unknown }[];
  let inserts: unknown[];

  const RULE_ROW = {
    weekday: 1,
    start_time: new Date('1970-01-01T09:00:00Z'),
    end_time: new Date('1970-01-01T11:00:00Z'),
    slot_duration_minutes: 30,
  };

  const PRO_ROW = {
    profile_id: PRO_ID,
    first_name: 'Ana',
    last_name: 'Médica',
    consultation_price: 15000,
    currency: 'ARS',
  };

  const APPOINTMENT_ROW = {
    id: '33333333-3333-4333-8333-333333333333',
    patient_id: PATIENT_ID,
    professional_id: PRO_ID,
    scheduled_at: '2026-08-17T13:00:00.000Z',
    duration_minutes: 30,
    price: '15000.00',
    status: 'RESERVADO_SIN_PAGAR',
  };

  function makeSupabaseMock() {
    const builder: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve(results.shift() ?? { data: null, error: null });
          }
          return (...args: unknown[]) => {
            if (prop === 'insert') inserts.push(args[0]);
            return builder;
          };
        },
      },
    );
    const client = { from: () => builder, auth: {} };
    return {
      getClient: () => client,
      getClientForToken: () => client,
      getJWKS: () => publicKey,
      getIssuer: () => ISSUER,
    };
  }

  function makePrismaMock() {
    return {
      professional: {
        findFirst: jest.fn().mockResolvedValue(PRO_ROW),
        findMany: jest.fn().mockResolvedValue([PRO_ROW]),
      },
      patient: {
        findMany: jest.fn().mockResolvedValue([
          {
            profile_id: PATIENT_ID,
            first_name: 'Juan',
            last_name: 'Paciente',
          },
        ]),
      },
      scheduleRule: { findMany: jest.fn().mockResolvedValue([RULE_ROW]) },
      scheduleBlock: { findMany: jest.fn().mockResolvedValue([]) },
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
      profile: { findUnique: jest.fn() },
    };
  }

  let prisma: ReturnType<typeof makePrismaMock>;

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    results = [];
    inserts = [];
    prisma = makePrismaMock();

    // El horizonte de reserva y el marcado de horarios pasados dependen del
    // reloj: sin fijarlo, estos tests dejarían de pasar el 15/09/2026.
    //
    // Se falsea SOLO `Date`. Falsear también los timers cuelga a supertest, que
    // necesita que el event loop siga corriendo para resolver el request.
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
        'performance',
      ],
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(makeSupabaseMock())
      .overrideProvider(PrismaService)
      .useValue(prisma)
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
    jest.useRealTimers();
    await app.close();
  });

  function signToken(sub = PATIENT_ID): Promise<string> {
    return new SignJWT({ email: 'paciente@test.com', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  describe('GET /professionals/:id/availability', () => {
    const path = `/professionals/${PRO_ID}/availability`;

    it('sin token devuelve 401', async () => {
      await request(app.getHttpServer())
        .get(path)
        .query({ from: MONDAY, to: MONDAY })
        .expect(401);
    });

    it('devuelve la grilla con el profesional y sus horarios', async () => {
      const res = await request(app.getHttpServer())
        .get(path)
        .query({ from: MONDAY, to: MONDAY })
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(200);

      expect(res.body.professional).toMatchObject({
        id: PRO_ID,
        firstName: 'Ana',
        consultationPrice: 15000,
      });
      expect(res.body.days[0].slots).toHaveLength(4);
      expect(res.body.days[0].slots[0]).toEqual({
        startTime: '09:00',
        durationMinutes: 30,
        status: 'AVAILABLE',
      });
    });

    it('rechaza un id de profesional que no es UUID', async () => {
      await request(app.getHttpServer())
        .get('/professionals/no-soy-uuid/availability')
        .query({ from: MONDAY, to: MONDAY })
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(400);
    });

    it('rechaza un rango con formato inválido', async () => {
      await request(app.getHttpServer())
        .get(path)
        .query({ from: '17-08-2026', to: MONDAY })
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(400);
    });

    it('rechaza parámetros desconocidos', async () => {
      await request(app.getHttpServer())
        .get(path)
        .query({ from: MONDAY, to: MONDAY, professionalId: PRO_ID })
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(400);
    });

    it('un profesional sin validar da 404', async () => {
      prisma.professional.findFirst.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get(path)
        .query({ from: MONDAY, to: MONDAY })
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(404);
    });
  });

  describe('POST /appointments', () => {
    const VALID = { professionalId: PRO_ID, date: MONDAY, startTime: '10:00' };

    it('sin token devuelve 401 y no escribe nada', async () => {
      await request(app.getHttpServer())
        .post('/appointments')
        .send(VALID)
        .expect(401);

      expect(inserts).toHaveLength(0);
    });

    it('reserva y devuelve 201 con el turno en hora local', async () => {
      results = [
        { data: { profile_id: PATIENT_ID }, error: null },
        { data: [], error: null },
        { data: APPOINTMENT_ROW, error: null },
      ];

      const res = await request(app.getHttpServer())
        .post('/appointments')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send(VALID)
        .expect(201);

      expect(res.body).toMatchObject({
        date: MONDAY,
        startTime: '10:00',
        status: 'RESERVADO_SIN_PAGAR',
        price: 15000,
      });
      expect(inserts[0]).toMatchObject({ patient_id: PATIENT_ID });
    });

    it('rechaza que el cliente mande precio o estado', async () => {
      // `forbidNonWhitelisted`: aceptarlos dejaría reservar un turno a $0 o ya
      // confirmado sin pagar.
      await request(app.getHttpServer())
        .post('/appointments')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ ...VALID, price: 0, status: 'CONFIRMADO' })
        .expect(400);

      expect(inserts).toHaveLength(0);
    });

    it('rechaza que el cliente mande patientId', async () => {
      // El paciente es el `sub` del JWT, y RLS lo respalda en la base.
      await request(app.getHttpServer())
        .post('/appointments')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ ...VALID, patientId: PRO_ID })
        .expect(400);
    });

    it('devuelve 409 cuando el turno se lo llevó otro en el medio', async () => {
      results = [
        { data: { profile_id: PATIENT_ID }, error: null },
        { data: [], error: null },
        { data: null, error: { code: '23505' } },
      ];

      const res = await request(app.getHttpServer())
        .post('/appointments')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send(VALID)
        .expect(409);

      expect(res.body.message).toMatch(/otra persona/i);
    });

    it('devuelve 409 si el paciente no completó su perfil', async () => {
      results = [{ data: null, error: null }];

      const res = await request(app.getHttpServer())
        .post('/appointments')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send(VALID)
        .expect(409);

      expect(res.body.message).toMatch(/completá tu perfil/i);
    });
  });

  describe('GET /appointments/me', () => {
    it('sin token devuelve 401', async () => {
      await request(app.getHttpServer()).get('/appointments/me').expect(401);
    });

    it('devuelve los turnos del usuario con los nombres resueltos', async () => {
      results = [{ data: [APPOINTMENT_ROW], error: null }];

      const res = await request(app.getHttpServer())
        .get('/appointments/me')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        date: MONDAY,
        startTime: '10:00',
        professional: { firstName: 'Ana', lastName: 'Médica' },
      });
    });

    it('sin turnos devuelve una lista vacía, no un 404', async () => {
      results = [{ data: [], error: null }];

      const res = await request(app.getHttpServer())
        .get('/appointments/me')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(200);

      expect(res.body).toEqual([]);
    });
  });
});
