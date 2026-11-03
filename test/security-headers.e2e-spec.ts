import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * ENG-166: los headers de seguridad llegan en las respuestas reales de la app,
 * también en las de error. Usa `configureApp`, el mismo cableado de `main.ts`.
 */
describe('Headers de seguridad (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Sin base real: ver app.e2e-spec.ts.
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function expectSecurityHeaders(headers: Record<string, unknown>) {
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['strict-transport-security']).toContain('max-age=31536000');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-powered-by']).toBeUndefined();
  }

  it('los trae en una respuesta OK', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);

    expectSecurityHeaders(res.headers);
  });

  it('los trae en un 404', async () => {
    const res = await request(app.getHttpServer())
      .get('/no-existe')
      .expect(404);

    expectSecurityHeaders(res.headers);
  });

  it('los trae en un 401 (ruta protegida sin sesión)', async () => {
    const res = await request(app.getHttpServer()).get('/me').expect(401);

    expectSecurityHeaders(res.headers);
  });
});
