import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { SupabaseService } from './../src/supabase/supabase.service';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';

describe('Auth registro (e2e)', () => {
  let app: INestApplication<App>;
  const signUp = jest.fn();
  const signInWithPassword = jest.fn();
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;

  const valid = {
    email: 'nuevo@test.com',
    password: 'Password1',
    passwordConfirmation: 'Password1',
  };

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    signUp.mockReset();
    signInWithPassword.mockReset();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Reemplazamos Supabase por un mock: el e2e prueba el stack HTTP
      // (routing + ValidationPipe + controller + service) sin llamar afuera.
      // getJWKS/getIssuer devuelven una clave local para que JwtAuthGuard
      // verifique tokens firmados en el test, sin red.
      .overrideProvider(SupabaseService)
      .useValue({
        getClient: () => ({ auth: { signUp, signInWithPassword } }),
        getJWKS: () => publicKey,
        getIssuer: () => ISSUER,
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
  });

  afterEach(async () => {
    await app.close();
  });

  it('201 con datos válidos (usuario nuevo)', () => {
    signUp.mockResolvedValue({
      data: { user: { identities: [{ id: 'x' }] } },
      error: null,
    });
    return request(app.getHttpServer())
      .post('/auth/register')
      .send(valid)
      .expect(201)
      .expect((res) => {
        expect(res.body.message).toContain('Revisá tu email');
      });
  });

  it('201 con email ya existente y devuelve el mismo mensaje genérico', () => {
    signUp.mockResolvedValue({
      data: { user: { identities: [] } },
      error: null,
    });
    return request(app.getHttpServer())
      .post('/auth/register')
      .send(valid)
      .expect(201)
      .expect((res) => {
        expect(res.body.message).toContain('Revisá tu email');
      });
  });

  it('400 con contraseña débil', () => {
    return request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...valid, password: 'abc', passwordConfirmation: 'abc' })
      .expect(400);
  });

  it('400 cuando las contraseñas no coinciden', () => {
    return request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...valid, passwordConfirmation: 'Otra1234' })
      .expect(400);
  });

  it('400 ante un campo desconocido (whitelist)', () => {
    return request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...valid, isAdmin: true })
      .expect(400);
  });

  const creds = { email: 'user@test.com', password: 'Password1' };

  it('200 login OK setea cookie httpOnly y devuelve el usuario (sin tokens en el body)', () => {
    signInWithPassword.mockResolvedValue({
      data: {
        session: { access_token: 'acc', refresh_token: 'ref' },
        user: { id: 'uid', email: creds.email },
      },
      error: null,
    });
    return request(app.getHttpServer())
      .post('/auth/login')
      .send(creds)
      .expect(200)
      .expect('set-cookie', /sb-access-token=.*HttpOnly/i)
      .expect((res) => {
        expect(res.body.user.email).toBe(creds.email);
        expect(res.body.accessToken).toBeUndefined();
        expect(res.body.refreshToken).toBeUndefined();
      });
  });

  it('401 login con credenciales inválidas', () => {
    signInWithPassword.mockResolvedValue({
      data: {},
      error: { code: 'invalid_credentials', status: 400, message: 'invalid' },
    });
    return request(app.getHttpServer())
      .post('/auth/login')
      .send(creds)
      .expect(401);
  });

  it('401 login con email sin confirmar (mismo mensaje genérico)', () => {
    signInWithPassword.mockResolvedValue({
      data: {},
      error: {
        code: 'email_not_confirmed',
        status: 400,
        message: 'not confirmed',
      },
    });
    return request(app.getHttpServer())
      .post('/auth/login')
      .send(creds)
      .expect(401);
  });

  async function signToken(): Promise<string> {
    return new SignJWT({ email: 'paciente@test.com', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject('user-id-123')
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  it('200 GET /auth/me con la cookie de sesión devuelve el usuario', async () => {
    const token = await signToken();
    return request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', [`sb-access-token=${token}`])
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({
          id: 'user-id-123',
          email: 'paciente@test.com',
          role: 'authenticated',
        });
      });
  });

  it('200 GET /auth/me con Authorization: Bearer devuelve el usuario', async () => {
    const token = await signToken();
    return request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('401 GET /auth/me sin token', () => {
    return request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('401 GET /auth/me con token inválido', () => {
    return request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', ['sb-access-token=token-invalido'])
      .expect(401);
  });

  it('200 POST /auth/logout limpia las cookies de sesión', () => {
    return request(app.getHttpServer())
      .post('/auth/logout')
      .expect(200)
      .expect((res) => {
        const setCookie = res.headers['set-cookie'] as unknown as string[];
        expect(
          setCookie.some((c) => /sb-access-token=;.*Expires/i.test(c)),
        ).toBe(true);
        expect(
          setCookie.some((c) => /sb-refresh-token=;.*Expires/i.test(c)),
        ).toBe(true);
      });
  });
});
