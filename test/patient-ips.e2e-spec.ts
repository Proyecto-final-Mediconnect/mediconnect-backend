import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * `POST /patients/me/ips/preview` (ENG-246) con la app real: guard, body JSON
 * sin DTO bajo el `ValidationPipe` global y la comparación del DNI. Lo que se
 * lee del documento está en el spec de `readIps`.
 */
const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const EJEMPLO: unknown = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/ips-argentina-ejemplo.json'), 'utf8'),
);

describe('Resumen IPS del paciente (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  /** La fila de `patients` que devuelve Supabase al pedir el perfil. */
  let fila: Record<string, unknown> | null;

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    fila = null;
    const consulta = {
      select: () => consulta,
      eq: () => consulta,
      maybeSingle: () => Promise.resolve({ data: fila, error: null }),
    };
    const supabase = {
      getClient: () => ({ from: () => ({}), auth: {} }),
      getClientForToken: () => ({ from: () => consulta }),
      getJWKS: () => publicKey,
      getIssuer: () => ISSUER,
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabase)
      .overrideProvider(PrismaService)
      .useValue({
        profile: { findUnique: jest.fn() },
        ...legalAcceptedPrismaMock(),
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

  function signToken(sub: string): Promise<string> {
    return new SignJWT({
      email: 'x@test.com',
      role: 'authenticated',
      aal: 'aal2',
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  async function preview(body: unknown) {
    return request(app.getHttpServer())
      .post('/patients/me/ips/preview')
      .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
      .send(body as object);
  }

  it('sin token devuelve 401', async () => {
    await request(app.getHttpServer())
      .post('/patients/me/ips/preview')
      .send(EJEMPLO as object)
      .expect(401);
  });

  it('con el ejemplo oficial devuelve la propuesta sin guardar nada, y sin el DNI', async () => {
    const res = await preview(EJEMPLO);
    expect(res.status).toBe(200);

    expect(res.body.propuesta.allergies).toEqual([
      { que: 'alergia a la penicilina', gravedad: 'Grave' },
    ]);
    expect(res.body.documento).toEqual({
      titulo: 'Resumen del paciente al 26 de Enero de 2018, 14:30hs',
      fecha: '2018-01-26T14:30:00-03:00',
      dniCoincide: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('99999999');
  });

  it('test_should_warn_given_ips_dni_different_from_patient', async () => {
    fila = {
      profile_id: PATIENT,
      first_name: 'Ana',
      last_name: 'P',
      dni: '30418992',
    };

    const res = await preview(EJEMPLO);
    expect(res.status).toBe(200);

    expect(res.body.documento.dniCoincide).toBe(false);
  });

  it('dice que coincide si el DNI es el del paciente', async () => {
    fila = {
      profile_id: PATIENT,
      first_name: 'Ana',
      last_name: 'P',
      dni: '99.999.999',
    };

    const res = await preview(EJEMPLO);
    expect(res.status).toBe(200);

    expect(res.body.documento.dniCoincide).toBe(true);
  });

  it('un archivo que no es IPS da 400 con un mensaje claro', async () => {
    const res = await preview({ resourceType: 'Patient' });
    expect(res.status).toBe(400);

    expect(res.body.message).toMatch(/no es un resumen de salud IPS/);
  });
});
