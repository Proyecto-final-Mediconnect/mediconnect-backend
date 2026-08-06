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
const SUB = 'user-id-123';

describe('GET /me (e2e)', () => {
  let app: INestApplication<App>;
  // Prisma se mockea a nivel de método usado por UserService: no hay base real.
  const findUnique = jest.fn();
  // Par de claves "buenas": el guard verifica contra `publicKey`.
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;
  // Par "atacante": firma tokens con firma inválida para el JWKS del proyecto.
  let attackerKey: CryptoKey;

  const patientRow = {
    id: SUB,
    email: 'paciente@test.com',
    role: 'PACIENTE',
    patient: { first_name: 'Ana', last_name: 'García' },
    professional: null,
  };

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
    ({ privateKey: attackerKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    findUnique.mockReset();
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
      .useValue({ profile: { findUnique } })
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

  /** Firma un JWT de sesión válido de Supabase (ES256 + iss + aud). */
  function signToken(
    options: {
      key?: CryptoKey;
      expired?: boolean;
      extraClaims?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const { key = privateKey, expired = false, extraClaims = {} } = options;
    return new SignJWT({
      email: 'paciente@test.com',
      role: 'authenticated',
      ...extraClaims,
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(SUB)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(expired ? '-1h' : '1h')
      .sign(key);
  }

  it('test_should_return_profile_given_valid_access_token', async () => {
    findUnique.mockResolvedValue(patientRow);
    const token = await signToken();

    return request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({
          id: SUB,
          email: 'paciente@test.com',
          role: 'PACIENTE',
          firstName: 'Ana',
          lastName: 'García',
        });
      });
  });

  it('acepta la cookie sb-access-token además del header Bearer', async () => {
    findUnique.mockResolvedValue(patientRow);
    const token = await signToken();

    return request(app.getHttpServer())
      .get('/me')
      .set('Cookie', [`sb-access-token=${token}`])
      .expect(200)
      .expect((res) => {
        expect(res.body.id).toBe(SUB);
      });
  });

  it('test_should_return_401_given_no_token', () => {
    return request(app.getHttpServer()).get('/me').expect(401);
  });

  it('test_should_return_401_given_expired_token', async () => {
    const token = await signToken({ expired: true });

    return request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('test_should_return_401_given_invalid_signature', async () => {
    const token = await signToken({ key: attackerKey });

    return request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('test_should_return_404_given_valid_jwt_without_profile', async () => {
    findUnique.mockResolvedValue(null);
    const token = await signToken();

    return request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('test_should_not_expose_sensitive_fields_given_valid_token', async () => {
    // Prisma podría devolver de más si el select cambiara: forzamos campos
    // sensibles en la fila y verificamos que NO salgan en la respuesta.
    findUnique.mockResolvedValue({
      ...patientRow,
      mfa_enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const token = await signToken();

    return request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res) => {
        expect(Object.keys(res.body as Record<string, unknown>).sort()).toEqual(
          ['email', 'firstName', 'id', 'lastName', 'role'],
        );
        expect(res.body.password).toBeUndefined();
        expect(res.body.mfa_enabled).toBeUndefined();
        expect(res.body.token).toBeUndefined();
      });
  });

  it('test_should_read_role_from_profiles_table_given_tampered_user_metadata', async () => {
    // El perfil real en la base es PACIENTE...
    findUnique.mockResolvedValue(patientRow);
    // ...aunque el atacante infle user_metadata/role en su token.
    const token = await signToken({
      extraClaims: { user_metadata: { role: 'MODERADOR' }, role: 'MODERADOR' },
    });

    return request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.role).toBe('PACIENTE');
      });
  });
});
