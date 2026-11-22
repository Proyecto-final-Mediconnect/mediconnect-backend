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

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const SUB = '11111111-1111-4111-8111-111111111111';

/** ENG-240 — `/admin` solo para el rol ADMINISTRADOR, leído de `profiles`. */
describe('Administración (e2e)', () => {
  let app: INestApplication<App>;
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;
  const findUnique = jest.fn();

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
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
      .useValue({ ...legalAcceptedPrismaMock(), profile: { findUnique } })
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

  function signToken(extraClaims: Record<string, unknown> = {}) {
    return new SignJWT({
      email: 'admin@test.com',
      role: 'authenticated',
      aal: 'aal2',
      ...extraClaims,
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(SUB)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  /** El guard lee `role`; el service, `email`. */
  const perfil = (role: string) => ({
    id: SUB,
    email: 'admin@test.com',
    role,
    deleted_at: null,
  });

  it('test_should_allow_admin_given_admin_role_in_profiles', async () => {
    findUnique.mockResolvedValue(perfil('ADMINISTRADOR'));

    const res = await request(app.getHttpServer())
      .get('/admin/me')
      .set('Authorization', `Bearer ${await signToken()}`)
      .expect(200);

    expect(res.body).toEqual({
      id: SUB,
      email: 'admin@test.com',
      role: 'ADMINISTRADOR',
    });
  });

  it.each(['PACIENTE', 'PROFESIONAL'])(
    'test_should_return_403_given_non_admin_on_admin_endpoint (%s)',
    async (role) => {
      findUnique.mockResolvedValue(perfil(role));

      await request(app.getHttpServer())
        .get('/admin/me')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(403);
    },
  );

  it('el rol del token no cuenta: un paciente con ADMINISTRADOR en el metadata da 403', async () => {
    findUnique.mockResolvedValue(perfil('PACIENTE'));
    const token = await signToken({
      user_metadata: { role: 'ADMINISTRADOR' },
      role: 'ADMINISTRADOR',
    });

    await request(app.getHttpServer())
      .get('/admin/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('sin sesión da 401 y no mira la base', async () => {
    await request(app.getHttpServer()).get('/admin/me').expect(401);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
