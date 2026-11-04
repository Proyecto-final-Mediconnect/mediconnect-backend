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
 * Derechos ARCO por HTTP (ENG-86): rutas cerradas sin sesión, abiertas aunque
 * no se hayan aceptado los términos nuevos, la descarga como archivo y la frase
 * que hace falta para dar de baja.
 */
describe('Derechos ARCO (e2e)', () => {
  let app: INestApplication<App>;
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;

  const profileFindUnique = jest.fn();
  const profileUpdateMany = jest.fn();
  const updateUserById = jest.fn();
  const legalFindUnique = jest.fn();
  const auditCreate = jest.fn();

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    [
      profileFindUnique,
      profileUpdateMany,
      updateUserById,
      legalFindUnique,
      auditCreate,
    ].forEach((fn) => fn.mockReset());
    profileFindUnique.mockResolvedValue({
      email: 'marina@test.com',
      role: 'MODERADOR',
      created_at: new Date('2026-07-01T10:00:00.000Z'),
      deleted_at: null,
      email_reminders: true,
    });
    profileUpdateMany.mockResolvedValue({ count: 1 });
    updateUserById.mockResolvedValue({ error: null });
    // Nadie aceptó los términos vigentes: las rutas ARCO igual tienen que andar.
    legalFindUnique.mockResolvedValue(null);
    auditCreate.mockResolvedValue({});

    const prismaMock = {
      legalAcceptance: {
        findUnique: legalFindUnique,
        findMany: jest.fn().mockResolvedValue([]),
      },
      profile: {
        findUnique: profileFindUnique,
        updateMany: profileUpdateMany,
        update: jest.fn().mockResolvedValue({}),
      },
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      pushToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      appointment: { count: jest.fn().mockResolvedValue(0) },
      auditLog: { create: auditCreate },
      $transaction: (fn: (tx: unknown) => unknown) => fn(prismaMock),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        getClient: () => ({ auth: {} }),
        getJWKS: () => publicKey,
        getIssuer: () => ISSUER,
        getServiceClient: () => ({
          auth: {
            admin: {
              updateUserById,
              signOut: jest.fn().mockResolvedValue({ error: null }),
            },
          },
          storage: { from: () => ({ remove: jest.fn() }) },
        }),
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
    delete process.env.LEGAL_ENFORCEMENT;
    await app.close();
  });

  function token(): Promise<string> {
    return new SignJWT({
      email: 'marina@test.com',
      role: 'authenticated',
      aal: 'aal2',
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(SUB)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  it('sin sesión, ninguna ruta ARCO responde', async () => {
    const server = app.getHttpServer();
    await request(server).get('/me/data-export').expect(401);
    await request(server).get('/me/preferences').expect(401);
    await request(server).put('/me/preferences').expect(401);
    await request(server).delete('/me').expect(401);
  });

  it('acceso: descarga un archivo JSON, sin caché, y deja constancia', async () => {
    await request(app.getHttpServer())
      .get('/me/data-export')
      .set('Authorization', `Bearer ${await token()}`)
      .expect(200)
      .expect('Content-Type', /application\/json/)
      .expect('Cache-Control', 'no-store')
      .expect(
        'Content-Disposition',
        /^attachment; filename="mediconnect-mis-datos-\d{4}-\d{2}-\d{2}\.json"$/,
      )
      .expect((res) => {
        expect(res.body.cuenta.email).toBe('marina@test.com');
      });

    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor_id: SUB,
        action: 'ARCO_ACCESS_EXPORT',
      }),
    });
  });

  it('oposición: lee y apaga los recordatorios', async () => {
    const server = app.getHttpServer();
    const auth = `Bearer ${await token()}`;

    await request(server)
      .get('/me/preferences')
      .set('Authorization', auth)
      .expect(200, { recordatoriosPorEmail: true });

    await request(server)
      .put('/me/preferences')
      .set('Authorization', auth)
      .send({ recordatoriosPorEmail: false })
      .expect(200, { recordatoriosPorEmail: false });
  });

  it('oposición: un valor que no es booleano es 400', async () => {
    await request(app.getHttpServer())
      .put('/me/preferences')
      .set('Authorization', `Bearer ${await token()}`)
      .send({ recordatoriosPorEmail: 'no' })
      .expect(400);
    expect(profileUpdateMany).not.toHaveBeenCalled();
  });

  it('supresión: sin la frase exacta no da de baja nada', async () => {
    const server = app.getHttpServer();
    const auth = `Bearer ${await token()}`;

    await request(server).delete('/me').set('Authorization', auth).expect(400);
    await request(server)
      .delete('/me')
      .set('Authorization', auth)
      .send({ confirmacion: 'eliminar mi cuenta' })
      .expect(400);

    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('supresión: con la frase da de baja (204)', async () => {
    await request(app.getHttpServer())
      .delete('/me')
      .set('Authorization', `Bearer ${await token()}`)
      .send({ confirmacion: 'ELIMINAR MI CUENTA' })
      .expect(204);

    expect(updateUserById).toHaveBeenCalledWith(
      SUB,
      expect.objectContaining({ ban_duration: '876000h' }),
    );
  });

  it('con el consentimiento exigido y sin aceptar, los derechos igual se ejercen', async () => {
    process.env.LEGAL_ENFORCEMENT = 'true';
    await app.close();
    // Se reconstruye la app para que tome la variable.
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
        legalAcceptance: {
          findUnique: legalFindUnique,
          findMany: jest.fn().mockResolvedValue([]),
        },
        profile: { findUnique: profileFindUnique },
        notification: { findMany: jest.fn().mockResolvedValue([]) },
        auditLog: { create: auditCreate },
      })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .get('/me/data-export')
      .set('Authorization', `Bearer ${await token()}`)
      .expect(200);
  });
});
