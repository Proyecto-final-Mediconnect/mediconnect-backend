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
const CODE_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';

const PATIENT_ROW = {
  first_name: 'Marina',
  last_name: 'Ocampo',
  birth_date: new Date('1991-03-02T00:00:00.000Z'),
};

/**
 * La superficie HTTP del MediPass (ENG-72, ENG-73, ENG-103, ENG-104).
 *
 * Lo que se verifica acá y no en el spec del service es justamente lo que vive
 * en los controllers y en los guards: que las rutas del paciente estén cerradas,
 * que las dos públicas **no** pidan sesión, y que el 400 de validación y el 404
 * de código inválido salgan separados. La web depende de esa diferencia:
 * `openEmergencySession` muestra el mensaje del backend en un 400 y lo reemplaza
 * por "Código inválido o vencido" en cualquier otro 4xx, así que si el backend
 * las mezcla el médico recibe el consejo equivocado.
 */
describe('MediPass (e2e)', () => {
  let app: INestApplication<App>;
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;

  const patientFindUnique = jest.fn();
  const codeFindFirst = jest.fn();
  const codeCreate = jest.fn();
  const codeUpdateMany = jest.fn();
  const codeUpdate = jest.fn();
  const sessionCreate = jest.fn();
  const sessionFindUnique = jest.fn();
  const accessLogCreate = jest.fn();

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    [
      patientFindUnique,
      codeFindFirst,
      codeCreate,
      codeUpdateMany,
      codeUpdate,
      sessionCreate,
      sessionFindUnique,
      accessLogCreate,
    ].forEach((fn) => fn.mockReset());

    patientFindUnique.mockResolvedValue(PATIENT_ROW);
    codeUpdateMany.mockResolvedValue({ count: 0 });
    sessionCreate.mockResolvedValue({});
    accessLogCreate.mockResolvedValue({});

    const prismaMock = {
      ...legalAcceptedPrismaMock(),
      patient: { findUnique: patientFindUnique },
      mediPassCode: {
        findFirst: codeFindFirst,
        create: codeCreate,
        updateMany: codeUpdateMany,
        update: codeUpdate,
      },
      mediPassSession: {
        create: sessionCreate,
        findUnique: sessionFindUnique,
      },
      mediPassAccessLog: { create: accessLogCreate },
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

  function signToken(): Promise<string> {
    return new SignJWT({ email: 'paciente@test.com', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(SUB)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  describe('GET /medipass/me', () => {
    it('sin token no devuelve nada', async () => {
      await request(app.getHttpServer()).get('/medipass/me').expect(401);
      expect(codeFindFirst).not.toHaveBeenCalled();
    });

    it('con token devuelve el código y cuándo rota', async () => {
      const expira = new Date(Date.now() + 300_000);
      codeFindFirst.mockResolvedValue({
        code: 'BCD23FGH',
        expires_at: expira,
      });
      const token = await signToken();

      await request(app.getHttpServer())
        .get('/medipass/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect((res) => {
          // La forma exacta que tipa `MediPassCode` en la web.
          expect(res.body).toEqual({
            codigo: 'BCD23FGH',
            expiraEl: expira.toISOString(),
          });
        });
    });

    it('sin perfil cargado contesta 409 y dice qué hacer', async () => {
      patientFindUnique.mockResolvedValue(null);
      const token = await signToken();

      await request(app.getHttpServer())
        .get('/medipass/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(409)
        .expect((res) => {
          expect(res.body.message).toContain('perfil');
        });
    });
  });

  describe('GET /medipass/me/vital', () => {
    it('sin token no devuelve nada', async () => {
      await request(app.getHttpServer()).get('/medipass/me/vital').expect(401);
    });

    it('devuelve el bloque vital con la forma del contrato', async () => {
      const token = await signToken();

      await request(app.getHttpServer())
        .get('/medipass/me/vital')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.nombre).toBe('Marina Ocampo');
          expect(typeof res.body.edad).toBe('number');
          // Clínicos pendientes de ENG-134: la pantalla omite los nulos.
          expect(res.body.grupoSanguineo).toBeNull();
          expect(res.body.contacto).toBeNull();
        });
    });
  });

  describe('POST /medipass/sessions', () => {
    const valido = { codigo: 'BCD23FGH', nombre: 'Dra. Paula Ferrer' };

    it('es público: abre el acceso sin ninguna sesión', async () => {
      // Es el punto del MediPass. Quien escanea el QR en una guardia no tiene
      // cuenta y no va a crearse una ahí.
      codeFindFirst.mockResolvedValue({
        id: CODE_ID,
        patient_id: SUB,
        used_at: null,
        patient: PATIENT_ROW,
      });

      await request(app.getHttpServer())
        .post('/medipass/sessions')
        .send(valido)
        .expect(201)
        .expect((res) => {
          expect(res.body.sesionId).toMatch(/^[0-9a-f-]{36}$/);
          expect(res.body.vital.nombre).toBe('Marina Ocampo');
          expect(new Date(String(res.body.expiraEl)).getTime()).toBeGreaterThan(
            Date.now(),
          );
        });

      expect(accessLogCreate).toHaveBeenCalledTimes(1);
    });

    it('normaliza el código como lo tipea una persona', async () => {
      codeFindFirst.mockResolvedValue({
        id: CODE_ID,
        patient_id: SUB,
        used_at: null,
        patient: PATIENT_ROW,
      });

      await request(app.getHttpServer())
        .post('/medipass/sessions')
        .send({ ...valido, codigo: 'bcd2-3fgh' })
        .expect(201);

      const where = codeFindFirst.mock.calls[0][0] as {
        where: { code: string };
      };
      expect(where.where.code).toBe('BCD23FGH');
    });

    it('un código mal formado es 400 de validación, no "código inválido"', async () => {
      // Si contestara 404, el médico le pediría otro código al paciente en vez
      // de corregir el tipeo.
      await request(app.getHttpServer())
        .post('/medipass/sessions')
        .send({ ...valido, codigo: 'XX' })
        .expect(400);

      expect(codeFindFirst).not.toHaveBeenCalled();
    });

    it('sin nombre de quien consulta es 400: el historial sin nombre no sirve', async () => {
      await request(app.getHttpServer())
        .post('/medipass/sessions')
        .send({ codigo: valido.codigo })
        .expect(400);
    });

    it('un código que no existe es 404 con el mensaje único', async () => {
      codeFindFirst.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post('/medipass/sessions')
        .send(valido)
        .expect(404)
        .expect((res) => {
          expect(res.body.message).toBe('Código inválido o vencido.');
        });

      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it('rechaza campos que no son del contrato', async () => {
      // `forbidNonWhitelisted`: nadie decide desde el cuerpo cuánto dura su
      // propio acceso ni de qué paciente es.
      await request(app.getHttpServer())
        .post('/medipass/sessions')
        .send({ ...valido, patientId: SUB, expiraEl: '2030-01-01T00:00:00Z' })
        .expect(400);
    });
  });

  describe('GET /medipass/sessions/:id', () => {
    it('es público y devuelve la ficha mientras el acceso vive', async () => {
      const expira = new Date(Date.now() + 600_000);
      sessionFindUnique.mockResolvedValue({
        expires_at: expira,
        revoked_at: null,
        patient: PATIENT_ROW,
      });

      await request(app.getHttpServer())
        .get(`/medipass/sessions/${SESSION_ID}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).toEqual({
            expiraEl: expira.toISOString(),
            vital: expect.objectContaining({ nombre: 'Marina Ocampo' }),
          });
        });
    });

    it('410 cuando venció, para que la pantalla lo distinga de un corte de red', async () => {
      sessionFindUnique.mockResolvedValue({
        expires_at: new Date(Date.now() - 1_000),
        revoked_at: null,
        patient: PATIENT_ROW,
      });

      await request(app.getHttpServer())
        .get(`/medipass/sessions/${SESSION_ID}`)
        .expect(410);
    });

    it('410 cuando el paciente la revocó', async () => {
      sessionFindUnique.mockResolvedValue({
        expires_at: new Date(Date.now() + 600_000),
        revoked_at: new Date(),
        patient: PATIENT_ROW,
      });

      await request(app.getHttpServer())
        .get(`/medipass/sessions/${SESSION_ID}`)
        .expect(410);
    });

    it('una sesión inexistente es 404 y no dice más', async () => {
      sessionFindUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get(`/medipass/sessions/${SESSION_ID}`)
        .expect(404);
    });

    it('un id con forma inválida no llega a la base', async () => {
      await request(app.getHttpServer())
        .get('/medipass/sessions/no-es-uuid')
        .expect(404);

      expect(sessionFindUnique).not.toHaveBeenCalled();
    });
  });
});
