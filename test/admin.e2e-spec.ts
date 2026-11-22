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
  const professionalFindMany = jest.fn();
  const professionalUpdateMany = jest.fn();
  const professionalCount = jest.fn();
  const auditCreate = jest.fn();

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    findUnique.mockReset();
    professionalFindMany.mockReset().mockResolvedValue([]);
    professionalUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    professionalCount.mockReset().mockResolvedValue(0);
    auditCreate.mockReset().mockResolvedValue({});
    const prismaMock = {
      ...legalAcceptedPrismaMock(),
      profile: { findUnique },
      professional: {
        findMany: professionalFindMany,
        updateMany: professionalUpdateMany,
        findUnique: jest.fn(),
        count: professionalCount,
      },
      auditLog: {
        create: auditCreate,
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: (cb: (tx: unknown) => unknown) => cb(prismaMock),
    };
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
      .useValue(prismaMock)
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

  describe('matrículas (ENG-192)', () => {
    const PRO = '22222222-2222-4222-8222-222222222222';

    it('el administrador ve la cola de pendientes', async () => {
      findUnique.mockResolvedValue(perfil('ADMINISTRADOR'));

      await request(app.getHttpServer())
        .get('/admin/professionals/licenses')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(200)
        .expect([]);
      expect(professionalFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'PENDIENTE_VALIDACION_MATRICULA',
          }),
        }),
      );
    });

    it('un estado que no es de la cola da 400', async () => {
      findUnique.mockResolvedValue(perfil('ADMINISTRADOR'));

      await request(app.getHttpServer())
        .get('/admin/professionals/licenses?status=SUSPENDIDO')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(400);
    });

    it('rechazar sin motivo da 400 y no toca nada', async () => {
      findUnique.mockResolvedValue(perfil('ADMINISTRADOR'));

      await request(app.getHttpServer())
        .patch(`/admin/professionals/${PRO}/license`)
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ decision: 'RECHAZADO' })
        .expect(400);
      expect(professionalUpdateMany).not.toHaveBeenCalled();
    });

    it('validar responde el estado nuevo y queda auditado', async () => {
      findUnique.mockResolvedValue(perfil('ADMINISTRADOR'));

      await request(app.getHttpServer())
        .patch(`/admin/professionals/${PRO}/license`)
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ decision: 'VALIDADO' })
        .expect(200)
        .expect({ id: PRO, status: 'VALIDADO' });
      expect(auditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: SUB,
          action: 'PROFESSIONAL_LICENSE_VALIDATED',
        }),
      });
    });

    it('un profesional no puede validarse a sí mismo: 403', async () => {
      findUnique.mockResolvedValue(perfil('PROFESIONAL'));

      await request(app.getHttpServer())
        .patch(`/admin/professionals/${PRO}/license`)
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ decision: 'VALIDADO' })
        .expect(403);
      expect(professionalUpdateMany).not.toHaveBeenCalled();
    });

    it('un id que no es UUID da 400', async () => {
      findUnique.mockResolvedValue(perfil('ADMINISTRADOR'));

      await request(app.getHttpServer())
        .patch('/admin/professionals/no-es-un-id/license')
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ decision: 'VALIDADO' })
        .expect(400);
    });
  });

  describe('profesionales y suspensión (ENG-241)', () => {
    const PRO = '22222222-2222-4222-8222-222222222222';

    it('el listado responde la página, y "licenses" no se confunde con un id', async () => {
      findUnique.mockResolvedValue(perfil('ADMINISTRADOR'));
      professionalCount.mockResolvedValue(0);

      await request(app.getHttpServer())
        .get('/admin/professionals?status=SUSPENDIDO&q=ana&page=1')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(200)
        .expect({ items: [], total: 0, page: 1, pageSize: 20 });
      await request(app.getHttpServer())
        .get('/admin/professionals/licenses')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(200);
    });

    it('una página que no es un número da 400', async () => {
      findUnique.mockResolvedValue(perfil('ADMINISTRADOR'));

      await request(app.getHttpServer())
        .get('/admin/professionals?page=cero')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(400);
    });

    it('suspender sin motivo da 400 y no toca nada', async () => {
      findUnique.mockResolvedValue(perfil('ADMINISTRADOR'));

      await request(app.getHttpServer())
        .patch(`/admin/professionals/${PRO}/suspension`)
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ reason: 'corto' })
        .expect(400);
      expect(professionalUpdateMany).not.toHaveBeenCalled();
    });

    it('un paciente no puede suspender ni ver el listado: 403', async () => {
      findUnique.mockResolvedValue(perfil('PACIENTE'));
      const token = await signToken();

      await request(app.getHttpServer())
        .get('/admin/professionals')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/admin/professionals/${PRO}/suspension`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Un motivo cualquiera de prueba.' })
        .expect(403);
      expect(professionalUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('panel de plataforma (ENG-195)', () => {
    it('un profesional no ve las métricas de la plataforma: 403', async () => {
      findUnique.mockResolvedValue(perfil('PROFESIONAL'));

      await request(app.getHttpServer())
        .get('/admin/stats')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(403);
    });

    it('una fecha con otro formato da 400', async () => {
      findUnique.mockResolvedValue(perfil('ADMINISTRADOR'));

      await request(app.getHttpServer())
        .get('/admin/stats?from=01/09/2026')
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(400);
    });
  });

  it('sin sesión da 401 y no mira la base', async () => {
    await request(app.getHttpServer()).get('/admin/me').expect(401);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
