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

/**
 * Sesión de la app mobile (ENG-114): `POST /auth/mobile/login` y
 * `POST /auth/mobile/refresh` devuelven los tokens en el body, sin cookies, y
 * el access token que devuelven sirve como `Authorization: Bearer`.
 *
 * Las rutas de la web tienen su propio e2e (`auth.e2e-spec.ts`); acá solo se
 * comprueba que su contrato no cambió.
 */
describe('Auth mobile (e2e)', () => {
  let app: INestApplication<App>;
  const signInWithPassword = jest.fn();
  const refreshSession = jest.fn();
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  const creds = { email: 'paciente@test.com', password: 'Password1' };

  beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    signInWithPassword.mockReset();
    refreshSession.mockReset();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        getClient: () => ({
          auth: { signInWithPassword, refreshSession },
        }),
        getJWKS: () => publicKey,
        getIssuer: () => ISSUER,
      })
      .overrideProvider(PrismaService)
      .useValue({})
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

  function sesion(access: string, refresh: string) {
    return {
      data: {
        session: { access_token: access, refresh_token: refresh },
        user: { id: 'uid', email: creds.email },
      },
      error: null,
    };
  }

  describe('POST /auth/mobile/login', () => {
    it('200 devuelve los tokens en el body y no setea cookies', () => {
      signInWithPassword.mockResolvedValue(sesion('acc', 'ref'));

      return request(app.getHttpServer())
        .post('/auth/mobile/login')
        .send(creds)
        .expect(200)
        .expect('Cache-Control', 'no-store')
        .expect((res) => {
          expect(res.body).toEqual({
            user: { id: 'uid', email: creds.email },
            accessToken: 'acc',
            refreshToken: 'ref',
          });
          expect(res.headers['set-cookie']).toBeUndefined();
        });
    });

    it('401 con credenciales inválidas, con el mismo mensaje genérico que la web', () => {
      signInWithPassword.mockResolvedValue({
        data: {},
        error: { status: 400, message: 'Invalid login credentials' },
      });

      return request(app.getHttpServer())
        .post('/auth/mobile/login')
        .send(creds)
        .expect(401)
        .expect((res) => {
          expect(res.body.message).toBe('Email o contraseña incorrectos.');
        });
    });

    it('401 con email sin confirmar: mismo mensaje, no revela que la cuenta existe', () => {
      signInWithPassword.mockResolvedValue({
        data: {},
        error: { status: 400, message: 'Email not confirmed' },
      });

      return request(app.getHttpServer())
        .post('/auth/mobile/login')
        .send(creds)
        .expect(401)
        .expect((res) => {
          expect(res.body.message).toBe('Email o contraseña incorrectos.');
        });
    });

    it('400 con un email mal formado', () => {
      return request(app.getHttpServer())
        .post('/auth/mobile/login')
        .send({ email: 'no-es-un-email', password: 'x' })
        .expect(400);
    });

    it('429 tras superar el límite de 5 intentos por minuto', async () => {
      signInWithPassword.mockResolvedValue({
        data: {},
        error: { status: 400, message: 'Invalid login credentials' },
      });
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/auth/mobile/login')
          .send(creds);
      }

      return request(app.getHttpServer())
        .post('/auth/mobile/login')
        .send(creds)
        .expect(429);
    });
  });

  describe('POST /auth/mobile/refresh', () => {
    it('200 canjea el refresh token del body y devuelve el par nuevo', () => {
      refreshSession.mockResolvedValue(sesion('new-acc', 'new-ref'));

      return request(app.getHttpServer())
        .post('/auth/mobile/refresh')
        .send({ refreshToken: 'old-ref' })
        .expect(200)
        .expect('Cache-Control', 'no-store')
        .expect((res) => {
          expect(refreshSession).toHaveBeenCalledWith({
            refresh_token: 'old-ref',
          });
          expect(res.body.accessToken).toBe('new-acc');
          expect(res.body.refreshToken).toBe('new-ref');
          expect(res.headers['set-cookie']).toBeUndefined();
        });
    });

    it('ignora la cookie de la web: sin refresh token en el body es 400', () => {
      return request(app.getHttpServer())
        .post('/auth/mobile/refresh')
        .set('Cookie', ['sb-refresh-token=de-la-web'])
        .send({})
        .expect(400)
        .expect(() => {
          expect(refreshSession).not.toHaveBeenCalled();
        });
    });

    it('401 con un refresh token inválido o ya usado', () => {
      refreshSession.mockResolvedValue({
        data: {},
        error: { status: 400, message: 'Invalid Refresh Token' },
      });

      return request(app.getHttpServer())
        .post('/auth/mobile/refresh')
        .send({ refreshToken: 'token-viejo' })
        .expect(401);
    });

    it('503 si Supabase no responde: el cliente no tiene que borrar la sesión', () => {
      refreshSession.mockResolvedValue({
        data: {},
        error: { message: 'fetch failed' },
      });

      return request(app.getHttpServer())
        .post('/auth/mobile/refresh')
        .send({ refreshToken: 'ref' })
        .expect(503);
    });

    it('429 tras superar el límite de 5 por minuto', async () => {
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/auth/mobile/refresh')
          .send({ refreshToken: 'ref' });
      }

      return request(app.getHttpServer())
        .post('/auth/mobile/refresh')
        .send({ refreshToken: 'ref' })
        .expect(429);
    });
  });

  it('el access token del login mobile autentica como Bearer en una ruta protegida', async () => {
    const accessToken = await new SignJWT({
      email: creds.email,
      role: 'authenticated',
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject('uid')
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(privateKey);
    signInWithPassword.mockResolvedValue(sesion(accessToken, 'ref'));

    const login = await request(app.getHttpServer())
      .post('/auth/mobile/login')
      .send(creds)
      .expect(200);

    // `/me` lee el perfil de Prisma (stub vacío acá): lo que importa es que el
    // guard deje pasar el Bearer —un token rechazado daría 401—.
    const me = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${login.body.accessToken as string}`);
    expect(me.status).not.toBe(401);
  });

  it('no cambia el login de la web: sigue sin tokens en el body', () => {
    signInWithPassword.mockResolvedValue(sesion('acc', 'ref'));

    return request(app.getHttpServer())
      .post('/auth/login')
      .send(creds)
      .expect(200)
      .expect('set-cookie', /sb-access-token=.*HttpOnly/i)
      .expect((res) => {
        expect(res.body.accessToken).toBeUndefined();
        expect(res.body.refreshToken).toBeUndefined();
      });
  });
});
