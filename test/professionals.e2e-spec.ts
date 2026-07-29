import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  PAYLOAD_TOO_LARGE_MESSAGE,
  PayloadTooLargeFilter,
} from './../src/common/filters/payload-too-large.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const SUB = '11111111-1111-4111-8111-111111111111';

/**
 * Endpoints de perfil profesional (ENG-48) a nivel HTTP, con la app real: guard,
 * ValidationPipe global, Multer y los filtros globales. Lo único mockeado es
 * el cliente de Supabase (PostgREST/Storage), porque no hay forma de tenerlo en
 * local: los GRANT y las políticas RLS se verifican aparte, contra Postgres real.
 *
 * Los unit tests del service no pueden cubrir esto: el status y el mensaje reales de
 * un archivo demasiado grande, y la forma de cada respuesta de error, se deciden
 * FUERA del service (review de #19: "los tests mockean el cliente, por construcción
 * no pueden fallar por permisos ni por la forma de la query").
 */
describe('Perfil profesional (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  /** Cola de respuestas que devuelve el cliente mock, en orden. */
  let results: Array<{ data: unknown; error: unknown }>;
  /** Payloads pasados a `.update(...)`, para afirmar qué se escribe. */
  let updates: Record<string, unknown>[];

  const PRO_ROW = {
    profile_id: SUB,
    first_name: 'Ana',
    last_name: 'García',
    license_number: 'MP-12345',
    bio: 'Cardióloga.',
    photo_url: null,
    consultation_price: '15000.00',
    currency: 'ARS',
    status: 'PENDIENTE_VALIDACION_MATRICULA',
    updated_at: '2026-07-29T12:00:00.000Z',
    professional_specialties: [
      { specialty: { id: 's1', name: 'Cardiología' } },
    ],
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
            if (prop === 'update')
              updates.push(args[0] as Record<string, unknown>);
            return builder;
          };
        },
      },
    );
    const client = {
      from: () => builder,
      storage: {
        from: () => ({
          upload: () => Promise.resolve({ data: {}, error: null }),
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn/professional-photos/${path}` },
          }),
        }),
      },
      auth: {},
    };
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
    updates = [];
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
    app.useGlobalFilters(new PayloadTooLargeFilter());
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

  describe('GET /specialties', () => {
    it('es público y devuelve el catálogo', async () => {
      results = [{ data: [{ id: 's1', name: 'Cardiología' }], error: null }];

      await request(app.getHttpServer())
        .get('/specialties')
        .expect(200)
        .expect([{ id: 's1', name: 'Cardiología' }]);
    });

    it('devuelve 500 con un mensaje entendible si la base rechaza la lectura', async () => {
      // Es el síntoma exacto que tenía la base sin GRANT: 42501.
      results = [{ data: null, error: { message: 'permission denied' } }];

      await request(app.getHttpServer())
        .get('/specialties')
        .expect(500)
        .expect((res) => {
          expect(res.body.message).toMatch(
            /No pudimos cargar las especialidades/,
          );
        });
    });
  });

  describe('GET /professionals/me', () => {
    it('sin token devuelve 401', async () => {
      await request(app.getHttpServer()).get('/professionals/me').expect(401);
    });

    it('con token devuelve el perfil mapeado', async () => {
      results = [{ data: PRO_ROW, error: null }];
      const token = await signToken();

      await request(app.getHttpServer())
        .get('/professionals/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.consultationPrice).toBe(15000);
          expect(res.body.currency).toBe('ARS');
          expect(res.body.specialties).toEqual([
            { id: 's1', name: 'Cardiología' },
          ]);
        });
    });
  });

  describe('PATCH /professionals/me', () => {
    it('rechaza una bio de más de 500 caracteres', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .patch('/professionals/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ bio: 'x'.repeat(600) })
        .expect(400)
        .expect((res) => {
          expect(String(res.body.message)).toMatch(/500 caracteres/);
        });
    });

    it('rechaza más de 3 especialidades', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .patch('/professionals/me')
        .set('Authorization', `Bearer ${token}`)
        .send({
          specialtyIds: [
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            '33333333-3333-4333-8333-333333333333',
            '44444444-4444-4444-8444-444444444444',
          ],
        })
        .expect(400)
        .expect((res) => {
          expect(String(res.body.message)).toMatch(/hasta 3 especialidades/);
        });
    });

    it('acepta consultationPrice en null y lo escribe (borrar el precio)', async () => {
      results = [
        { data: { profile_id: SUB }, error: null }, // sonda de perfil
        { data: null, error: null }, // update
        { data: { ...PRO_ROW, consultation_price: null }, error: null }, // relectura
      ];
      const token = await signToken();

      await request(app.getHttpServer())
        .patch('/professionals/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ consultationPrice: null })
        .expect(200)
        .expect((res) => {
          expect(res.body.consultationPrice).toBeNull();
        });

      expect(updates.at(-1)).toMatchObject({ consultation_price: null });
    });

    it('un fallo de escritura no dice "no pudimos cargar tu perfil"', async () => {
      results = [{ data: null, error: { message: 'permission denied' } }];
      const token = await signToken();

      await request(app.getHttpServer())
        .patch('/professionals/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ bio: 'hola' })
        .expect(500)
        .expect((res) => {
          expect(res.body.message).toMatch(/No pudimos guardar tu perfil/);
          expect(res.body.message).not.toMatch(/cargar/);
        });
    });
  });

  describe('POST /professionals/me/photo', () => {
    it('sin archivo devuelve 400', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .post('/professionals/me/photo')
        .set('Authorization', `Bearer ${token}`)
        .expect(400)
        .expect((res) => {
          expect(res.body.message).toMatch(/Adjuntá una imagen/);
        });
    });

    it('rechaza un archivo que no es imagen', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .post('/professionals/me/photo')
        .set('Authorization', `Bearer ${token}`)
        .attach('photo', Buffer.from('%PDF-1.4'), {
          filename: 'x.pdf',
          contentType: 'application/pdf',
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.message).toMatch(/JPG, PNG o WEBP/);
        });
    });

    it('una foto de más de 2 MB devuelve 400 con el límite explicado', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .post('/professionals/me/photo')
        .set('Authorization', `Bearer ${token}`)
        .attach('photo', Buffer.alloc(3 * 1024 * 1024), {
          filename: 'grande.png',
          contentType: 'image/png',
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.message).toMatch(/2 MB/);
        });
    });

    it('un archivo por encima del tope duro del interceptor devuelve 413 en español', async () => {
      // Multer aborta dentro del interceptor; @nestjs/platform-express ya lo mapea
      // a 413 (no a 500), pero con su mensaje crudo en inglés "File too large".
      const token = await signToken();

      await request(app.getHttpServer())
        .post('/professionals/me/photo')
        .set('Authorization', `Bearer ${token}`)
        .attach('photo', Buffer.alloc(9 * 1024 * 1024), {
          filename: 'enorme.png',
          contentType: 'image/png',
        })
        .expect(413)
        .expect((res) => {
          expect(res.body.message).toBe(PAYLOAD_TOO_LARGE_MESSAGE);
          expect(res.body.message).not.toMatch(/File too large/);
        });
    });

    it('guarda la URL canónica y devuelve la versionada', async () => {
      results = [
        { data: { profile_id: SUB }, error: null }, // sonda de perfil
        { data: null, error: null }, // update de photo_url
        {
          data: {
            ...PRO_ROW,
            photo_url: `https://cdn/professional-photos/${SUB}/avatar.png`,
          },
          error: null,
        },
      ];
      const token = await signToken();

      await request(app.getHttpServer())
        .post('/professionals/me/photo')
        .set('Authorization', `Bearer ${token}`)
        .attach('photo', Buffer.from('fake-png'), {
          filename: 'foto.png',
          contentType: 'image/png',
        })
        .expect(201)
        .expect((res) => {
          expect(res.body.photoUrl).toContain('?v=');
        });

      expect(String(updates.at(-1)?.photo_url)).not.toContain('?v=');
    });
  });
});
