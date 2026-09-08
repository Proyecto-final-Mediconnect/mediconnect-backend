import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';

/**
 * Alta y lectura de entradas de HC a nivel HTTP (ENG-58), con la app real: guard,
 * `ValidationPipe` con `forbidNonWhitelisted`, `ParseUUIDPipe` y el throttler.
 *
 * Lo que se verifica acá es el borde: qué cuerpos entran, qué códigos salen y —lo
 * que más importa en esta tabla— que ninguna petición rechazada llegue a escribir
 * una fila, porque en una tabla append-only una fila escrita por error no se
 * puede borrar. Las reglas de negocio están en el spec del service.
 */
const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';
const PATIENT = '11111111-1111-4111-8111-111111111111';

describe('Historia clínica (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let prisma: {
    appointment: { findFirst: jest.Mock };
    clinicalRecordEntry: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
    };
  };
  let listRows: unknown[];

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    listRows = [];

    prisma = {
      appointment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'turno-1' }),
      },
      clinicalRecordEntry: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementation(
            ({ data }: { data: Record<string, unknown> }) => ({
              id: 'entry-1',
              ...data,
              sequence_number: BigInt(data.sequence_number as number),
            }),
          ),
      },
    };

    const supabase = {
      getClient: () => ({ from: () => ({}), auth: {} }),
      getClientForToken: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: listRows, error: null }),
            }),
          }),
        }),
      }),
      getJWKS: () => publicKey,
      getIssuer: () => ISSUER,
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabase)
      .overrideProvider(PrismaService)
      .useValue({ profile: { findUnique: jest.fn() }, ...prisma })
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

  function signToken(sub: string = PROFESSIONAL): Promise<string> {
    return new SignJWT({ email: 'pro@test.com', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  const url = (id: string = PATIENT) => `/patients/${id}/clinical-record`;
  const body = { entryType: 'CONSULTA', reason: 'Control de rutina' };

  describe('POST', () => {
    it('sin token devuelve 401 y no escribe nada', async () => {
      await request(app.getHttpServer()).post(url()).send(body).expect(401);

      expect(prisma.clinicalRecordEntry.create).not.toHaveBeenCalled();
    });

    it('crea la entrada y devuelve 201 con el hash', async () => {
      const res = await request(app.getHttpServer())
        .post(url())
        .set('Authorization', `Bearer ${await signToken()}`)
        .send(body)
        .expect(201);

      expect(res.body).toMatchObject({
        patientId: PATIENT,
        professionalId: PROFESSIONAL,
        sequenceNumber: 1,
        fhirResourceType: 'ClinicalImpression',
      });
      expect(res.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rechaza un professionalId mandado en el cuerpo', async () => {
      // La autoría sale del JWT. Aceptarla del cuerpo dejaría firmar a nombre de
      // otro, y la firma entra a la preimagen del hash.
      await request(app.getHttpServer())
        .post(url())
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({
          ...body,
          professionalId: '33333333-3333-4333-8333-333333333333',
        })
        .expect(400);

      expect(prisma.clinicalRecordEntry.create).not.toHaveBeenCalled();
    });

    it('rechaza un createdAt mandado en el cuerpo', async () => {
      // Antedatar un asiento clínico con la cadena cerrando igual.
      await request(app.getHttpServer())
        .post(url())
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ ...body, createdAt: '2020-01-01T00:00:00.000Z' })
        .expect(400);

      expect(prisma.clinicalRecordEntry.create).not.toHaveBeenCalled();
    });

    it('rechaza un tipo de entrada fuera del enum', async () => {
      await request(app.getHttpServer())
        .post(url())
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ ...body, entryType: 'INVENTADO' })
        .expect(400);
    });

    it('rechaza CORRECCION: eso es ENG-100 y necesita a quién corrige', async () => {
      await request(app.getHttpServer())
        .post(url())
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ ...body, entryType: 'CORRECCION' })
        .expect(400);
    });

    it('rechaza un motivo vacío de contenido obligatorio', async () => {
      await request(app.getHttpServer())
        .post(url())
        .set('Authorization', `Bearer ${await signToken()}`)
        .send({ entryType: 'CONSULTA' })
        .expect(400);
    });

    it('con un patientId que no es UUID da 400 sin escribir', async () => {
      await request(app.getHttpServer())
        .post(url('no-es-uuid'))
        .set('Authorization', `Bearer ${await signToken()}`)
        .send(body)
        .expect(400);

      expect(prisma.clinicalRecordEntry.create).not.toHaveBeenCalled();
    });

    it('un profesional sin turno con el paciente recibe 403 y no escribe', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post(url())
        .set('Authorization', `Bearer ${await signToken()}`)
        .send(body)
        .expect(403);

      expect(prisma.clinicalRecordEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('GET', () => {
    it('sin token devuelve 401', async () => {
      await request(app.getHttpServer()).get(url()).expect(401);
    });

    it('devuelve lo que deja ver RLS', async () => {
      listRows = [
        {
          id: 'e1',
          patient_id: PATIENT,
          professional_id: PROFESSIONAL,
          sequence_number: 1,
          entry_type: 'CONSULTA',
          fhir_resource_type: 'ClinicalImpression',
          content: { resourceType: 'ClinicalImpression' },
          consultation_id: null,
          corrects_entry_id: null,
          created_at: new Date('2026-08-27T12:00:00.000Z'),
          content_hash: 'a'.repeat(64),
          previous_hash: '0'.repeat(64),
        },
      ];

      const res = await request(app.getHttpServer())
        .get(url())
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ sequenceNumber: 1 });
    });

    it('una HC que el usuario no puede ver es [] y no 403', async () => {
      // Distinguir "vacía" de "no te la puedo mostrar" confirmaría que ese
      // paciente tiene historia clínica.
      const res = await request(app.getHttpServer())
        .get(url())
        .set('Authorization', `Bearer ${await signToken()}`)
        .expect(200);

      expect(res.body).toEqual([]);
    });
  });
});
