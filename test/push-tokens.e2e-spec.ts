import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';
import { legalAcceptedPrismaMock } from './legal-accepted.mock';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const SUB = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';

/**
 * La superficie HTTP de los tokens de push (ENG-71): detrás de sesión, la
 * validación corta antes de tocar la base, y se guarda y se borra el token del
 * usuario del JWT, nunca uno que mande el cliente.
 */
describe('Push tokens (e2e)', () => {
  let app: INestApplication<App>;
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;

  const upsert = jest.fn();
  const deleteMany = jest.fn();

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    upsert.mockReset().mockResolvedValue({});
    deleteMany.mockReset().mockResolvedValue({ count: 1 });

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
        pushToken: { upsert, deleteMany },
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

  function signToken(): Promise<string> {
    // `aal2` como el resto de los e2e: con un token sin segundo paso el guard
    // consulta `profiles.mfa_enabled` (ENG-88), que este mock no tiene.
    return new SignJWT({
      email: 'paciente@test.com',
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

  it('sin sesión no se registra ni se borra nada', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/push-tokens')
      .send({ token: TOKEN })
      .expect(401);
    await request(server)
      .delete(`/push-tokens/${encodeURIComponent(TOKEN)}`)
      .expect(401);
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('registra el token para el usuario del JWT', async () => {
    await request(app.getHttpServer())
      .post('/push-tokens')
      .set('Authorization', `Bearer ${await signToken()}`)
      .send({ token: TOKEN, platform: 'android' })
      .expect(204);

    expect(upsert).toHaveBeenCalledWith({
      where: { token: TOKEN },
      create: { user_id: SUB, token: TOKEN, platform: 'android' },
      update: { user_id: SUB, platform: 'android' },
    });
  });

  it.each([
    ['un token que no es de Expo', { token: 'fcm-token-crudo' }],
    ['una plataforma desconocida', { token: TOKEN, platform: 'windows' }],
    ['otro usuario en el body', { token: TOKEN, userId: 'otro' }],
  ])('400 con %s, sin tocar la base', async (_, body) => {
    await request(app.getHttpServer())
      .post('/push-tokens')
      .set('Authorization', `Bearer ${await signToken()}`)
      .send(body)
      .expect(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('borra solo el token del usuario del JWT', async () => {
    await request(app.getHttpServer())
      .delete(`/push-tokens/${encodeURIComponent(TOKEN)}`)
      .set('Authorization', `Bearer ${await signToken()}`)
      .expect(204);

    expect(deleteMany).toHaveBeenCalledWith({
      where: { token: TOKEN, user_id: SUB },
    });
  });

  it('borrar algo que no es un token da 400', async () => {
    await request(app.getHttpServer())
      .delete('/push-tokens/cualquier-cosa')
      .set('Authorization', `Bearer ${await signToken()}`)
      .expect(400);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
