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
const SUB = '11111111-1111-4111-8111-111111111111';

/**
 * Agenda semanal del profesional (ENG-53) a nivel HTTP, con la app real: guard,
 * ValidationPipe global y el ParseUUIDPipe del path. Lo único mockeado es el
 * cliente de Supabase (PostgREST), igual que en `professionals.e2e-spec.ts` y por
 * el mismo motivo: no hay PostgREST en local.
 *
 * Los GRANT y las políticas RLS NO se verifican acá — con el cliente mockeado, por
 * construcción, estos tests no pueden fallar por permisos. Eso se validó aparte
 * contra Supabase real, con el rol `authenticated` (ver descripción del PR).
 */
describe('Agenda del profesional (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  /** Cola de respuestas del cliente mock, en orden de consumo. */
  let results: Array<{ data: unknown; error: unknown }>;
  /** Payloads pasados a `.insert(...)`, para afirmar qué se escribe. */
  let inserts: unknown[];

  /** La sonda de existencia previa a toda escritura. */
  const PROFILE_EXISTS = { data: { profile_id: SUB }, error: null };
  const OK = { data: null, error: null };
  const EMPTY = { data: [], error: null };

  const RULE_ROW = {
    id: '22222222-2222-4222-8222-222222222222',
    weekday: 2,
    start_time: '09:00:00',
    end_time: '13:00:00',
    slot_duration_minutes: 30,
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

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    results = [];
    inserts = [];
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(makeSupabaseMock())
      .overrideProvider(PrismaService)
      .useValue({ profile: { findUnique: jest.fn() } })
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

  const VALID_RULE = {
    weekday: 2,
    startTime: '09:00',
    endTime: '13:00',
    slotDurationMinutes: 30,
  };

  describe('GET /professionals/me/schedule', () => {
    it('sin token devuelve 401', async () => {
      await request(app.getHttpServer())
        .get('/professionals/me/schedule')
        .expect(401);
    });

    it('con token devuelve reglas y bloqueos mapeados', async () => {
      results = [{ data: [RULE_ROW], error: null }, EMPTY];

      const res = await request(app.getHttpServer())
        .get('/professionals/me/schedule')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(200);

      expect(res.body).toEqual({
        rules: [
          {
            id: RULE_ROW.id,
            weekday: 2,
            startTime: '09:00',
            endTime: '13:00',
            slotDurationMinutes: 30,
          },
        ],
        blocks: [],
      });
    });
  });

  describe('PUT /professionals/me/schedule', () => {
    it('sin token devuelve 401', async () => {
      await request(app.getHttpServer())
        .put('/professionals/me/schedule')
        .send({ rules: [] })
        .expect(401);
    });

    it('guarda una agenda válida y escribe las horas en formato time', async () => {
      results = [PROFILE_EXISTS, OK, OK, EMPTY, EMPTY];

      await request(app.getHttpServer())
        .put('/professionals/me/schedule')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ rules: [VALID_RULE] })
        .expect(200);

      expect(inserts[0]).toEqual([
        {
          professional_id: SUB,
          weekday: 2,
          start_time: '09:00:00',
          end_time: '13:00:00',
          slot_duration_minutes: 30,
        },
      ]);
    });

    it('acepta turno mañana y turno tarde el mismo día', async () => {
      results = [PROFILE_EXISTS, OK, OK, EMPTY, EMPTY];

      await request(app.getHttpServer())
        .put('/professionals/me/schedule')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({
          rules: [
            VALID_RULE,
            { ...VALID_RULE, startTime: '16:00', endTime: '20:00' },
          ],
        })
        .expect(200);
    });

    it('rechaza franjas superpuestas con un mensaje que nombra el día', async () => {
      const res = await request(app.getHttpServer())
        .put('/professionals/me/schedule')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({
          rules: [
            VALID_RULE,
            { ...VALID_RULE, startTime: '12:00', endTime: '16:00' },
          ],
        })
        .expect(400);

      expect(res.body.message).toContain('martes');
      expect(res.body.message).toContain('se superponen');
    });

    it('rechaza una duración de turno fuera del catálogo', async () => {
      await request(app.getHttpServer())
        .put('/professionals/me/schedule')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ rules: [{ ...VALID_RULE, slotDurationMinutes: 20 }] })
        .expect(400);
    });

    it('rechaza campos desconocidos (whitelist del ValidationPipe)', async () => {
      await request(app.getHttpServer())
        .put('/professionals/me/schedule')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ rules: [{ ...VALID_RULE, professionalId: 'otro-usuario' }] })
        .expect(400);
    });

    it('con rules vacío responde 200 y no inserta nada', async () => {
      results = [PROFILE_EXISTS, OK, EMPTY, EMPTY];

      const res = await request(app.getHttpServer())
        .put('/professionals/me/schedule')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ rules: [] })
        .expect(200);

      expect(inserts).toHaveLength(0);
      expect(res.body.rules).toEqual([]);
    });

    it('un paciente (sin perfil profesional) recibe 404', async () => {
      results = [{ data: null, error: null }];

      await request(app.getHttpServer())
        .put('/professionals/me/schedule')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ rules: [VALID_RULE] })
        .expect(404);
    });
  });

  describe('POST /professionals/me/schedule/blocks', () => {
    it('sin horas crea un bloqueo de día completo y responde 201', async () => {
      results = [
        PROFILE_EXISTS,
        {
          data: {
            id: '33333333-3333-4333-8333-333333333333',
            block_date: '2026-09-02',
            start_time: null,
            end_time: null,
            reason: null,
          },
          error: null,
        },
      ];

      const res = await request(app.getHttpServer())
        .post('/professionals/me/schedule/blocks')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ blockDate: '2026-09-02' })
        .expect(201);

      expect(inserts[0]).toMatchObject({ start_time: null, end_time: null });
      expect(res.body.startTime).toBeNull();
    });

    it('con una sola de las dos horas devuelve 400 y lo explica', async () => {
      const res = await request(app.getHttpServer())
        .post('/professionals/me/schedule/blocks')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ blockDate: '2026-09-01', startTime: '14:00' })
        .expect(400);

      expect(res.body.message).toContain('día completo');
    });

    it('rechaza una fecha con formato inválido', async () => {
      await request(app.getHttpServer())
        .post('/professionals/me/schedule/blocks')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ blockDate: '01/09/2026' })
        .expect(400);
    });

    it('traduce el unique violation de la base a 409', async () => {
      results = [PROFILE_EXISTS, { data: null, error: { code: '23505' } }];

      await request(app.getHttpServer())
        .post('/professionals/me/schedule/blocks')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ blockDate: '2026-09-02' })
        .expect(409);
    });
  });

  describe('DELETE /professionals/me/schedule/blocks/:id', () => {
    it('borra un bloqueo propio y responde 204 sin cuerpo', async () => {
      results = [
        { data: [{ id: '33333333-3333-4333-8333-333333333333' }], error: null },
      ];

      const res = await request(app.getHttpServer())
        .delete(
          '/professionals/me/schedule/blocks/33333333-3333-4333-8333-333333333333',
        )
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(204);

      expect(res.body).toEqual({});
    });

    it('un id que no es UUID devuelve 400, no 500', async () => {
      await request(app.getHttpServer())
        .delete('/professionals/me/schedule/blocks/no-es-un-uuid')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(400);
    });

    it('un bloqueo inexistente o ajeno devuelve 404', async () => {
      // RLS lo haría invisible: el delete no afecta filas y PostgREST devuelve [].
      results = [EMPTY];

      await request(app.getHttpServer())
        .delete(
          '/professionals/me/schedule/blocks/44444444-4444-4444-8444-444444444444',
        )
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(404);
    });
  });
});
