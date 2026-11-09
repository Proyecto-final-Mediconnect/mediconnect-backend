import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { clearMfaCache } from './../src/auth/guards/mfa-status-cache';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';
import { legalAcceptedPrismaMock } from './legal-accepted.mock';

/**
 * Alta de la verificación en dos pasos (ENG-88): `/me/mfa/*` con el guard real
 * y la API de Supabase Auth mockeada con `fetch`.
 */

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const SUB = '11111111-1111-4111-8111-111111111111';
const FACTOR = '22222222-2222-4222-8222-222222222222';

function goTrue(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe('Verificación en dos pasos: alta (e2e)', () => {
  let app: INestApplication<App>;
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;
  const profileUpdate = jest.fn();
  const auditCreate = jest.fn();

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    clearMfaCache();
    profileUpdate.mockReset().mockResolvedValue({});
    auditCreate.mockReset().mockResolvedValue({});
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
      .useValue({
        ...legalAcceptedPrismaMock(),
        profile: {
          findUnique: jest.fn().mockResolvedValue({ mfa_enabled: false }),
          update: profileUpdate,
        },
        auditLog: { create: auditCreate },
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
    jest.restoreAllMocks();
    await app.close();
  });

  function signToken(aal: 'aal1' | 'aal2' = 'aal1'): Promise<string> {
    return new SignJWT({ email: 'ana@test.com', role: 'authenticated', aal })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(SUB)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  it('el alta borra solo TOTP sin verificar y audita IP, user-agent y factor aunque falle la auditoría', async () => {
    auditCreate.mockRejectedValue(new Error('db'));
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        goTrue({
          id: SUB,
          factors: [
            { id: 'tel', factor_type: 'phone', status: 'unverified' },
            { id: 'viejo', factor_type: 'totp', status: 'unverified' },
          ],
        }),
      )
      .mockResolvedValueOnce(goTrue({}))
      .mockResolvedValueOnce(
        goTrue({ id: FACTOR, totp: { qr_code: 'qr', secret: 's' } }),
      );

    const res = await request(app.getHttpServer())
      .post('/me/mfa/enroll')
      .set('Authorization', `Bearer ${await signToken()}`)
      .set('CF-Connecting-IP', '203.0.113.7')
      .set('User-Agent', 'Navegador/1.0')
      .expect(200);

    expect(res.body).toEqual({ factorId: FACTOR, qr: 'qr', secret: 's' });
    expect(res.headers['cache-control']).toBe('no-store');
    const llamadas = (
      fetchSpy.mock.calls as unknown as [string, RequestInit][]
    ).map(([url, init]) => `${init.method} ${url.replace(ISSUER, '')}`);
    expect(llamadas).toEqual([
      'GET /user',
      'DELETE /factors/viejo',
      'POST /factors',
    ]);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'MFA_ENROLL_STARTED',
        metadata: {
          ip: '203.0.113.7',
          userAgent: 'Navegador/1.0',
          factorId: FACTOR,
        },
      }),
    });
  });

  it('con el factor ya verificado y el perfil sin marcar, corrige el perfil y responde 409', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      goTrue({
        id: SUB,
        factors: [{ id: FACTOR, factor_type: 'totp', status: 'verified' }],
      }),
    );

    await request(app.getHttpServer())
      .post('/me/mfa/enroll')
      .set('Authorization', `Bearer ${await signToken()}`)
      .expect(409);

    expect(profileUpdate).toHaveBeenCalledWith({
      where: { id: SUB },
      data: { mfa_enabled: true },
    });
  });

  it('si falla guardar el perfil al confirmar da 503, y el reintento la activa', async () => {
    profileUpdate.mockRejectedValueOnce(new Error('db'));
    const sesion = goTrue({
      access_token: 'acc-aal2',
      refresh_token: 'ref-aal2',
      user: { id: SUB, email: 'ana@test.com' },
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(goTrue({ id: 'challenge-1' }))
      .mockResolvedValueOnce(sesion)
      .mockResolvedValueOnce(goTrue({ id: 'challenge-2' }))
      .mockResolvedValueOnce(sesion);
    const token = await signToken();

    const fallo = await request(app.getHttpServer())
      .post('/me/mfa/enroll/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ factorId: FACTOR, code: '123456' })
      .expect(503);
    expect(fallo.body.message).toMatch(/Probá confirmar de nuevo/);

    // La sesión vieja sigue sirviendo (el perfil quedó sin marcar).
    const res = await request(app.getHttpServer())
      .post('/me/mfa/enroll/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ factorId: FACTOR, code: '654321' })
      .expect(200);

    expect(res.body).toEqual({
      activa: true,
      accessToken: 'acc-aal2',
      refreshToken: 'ref-aal2',
    });
    expect(profileUpdate).toHaveBeenLastCalledWith({
      where: { id: SUB },
      data: { mfa_enabled: true },
    });
  });
});
