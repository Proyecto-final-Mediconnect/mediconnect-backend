import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';
import { legalAcceptedPrismaMock } from './legal-accepted.mock';

const SECRET = 'secreto-de-prueba-de-jobs';
const URL = '/internal/jobs/close-expired-medipass-sessions';

/**
 * La barrera de `/internal/jobs/*` (ENG-104): el endpoint de cierre de accesos
 * al MediPass tiene que heredar `JobSecretGuard` del controller. Sin secreto en
 * el request es 401, y sin `JOBS_SECRET` configurado es 503 (jobs apagados, no
 * abiertos).
 */
describe('Jobs internos (e2e)', () => {
  let app: INestApplication<App>;
  const executeRaw = jest.fn();
  const previo = process.env.JOBS_SECRET;

  async function levantar(secret: string | undefined) {
    if (secret === undefined) delete process.env.JOBS_SECRET;
    else process.env.JOBS_SECRET = secret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        getClient: () => ({ auth: {} }),
        getJWKS: () => undefined,
        getIssuer: () => 'https://project-ref.supabase.co/auth/v1',
      })
      .overrideProvider(PrismaService)
      .useValue({
        ...legalAcceptedPrismaMock(),
        $executeRaw: executeRaw,
      })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  }

  beforeEach(() => executeRaw.mockReset().mockResolvedValue(0));

  afterEach(async () => {
    await app.close();
    if (previo === undefined) delete process.env.JOBS_SECRET;
    else process.env.JOBS_SECRET = previo;
  });

  it('401 sin Authorization y no toca la base', async () => {
    await levantar(SECRET);
    await request(app.getHttpServer()).post(URL).expect(401);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('401 con un secreto incorrecto', async () => {
    await levantar(SECRET);
    await request(app.getHttpServer())
      .post(URL)
      .set('Authorization', 'Bearer otro-secreto')
      .expect(401);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('503 si JOBS_SECRET no está configurado, aunque mande un Bearer', async () => {
    await levantar(undefined);
    await request(app.getHttpServer())
      .post(URL)
      .set('Authorization', 'Bearer cualquiera')
      .expect(503);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('200 con el secreto correcto', async () => {
    executeRaw.mockResolvedValue(2);
    await levantar(SECRET);
    const res = await request(app.getHttpServer())
      .post(URL)
      .set('Authorization', `Bearer ${SECRET}`)
      .expect(200);
    expect(res.body).toEqual({ closed: 2 });
  });
});
