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
 * Documentación que aporta el paciente a nivel HTTP (ENG-164), con la app real:
 * guard, multipart, `ValidationPipe` y que `patients/me/...` no se confunda con
 * `patients/:patientId/...`. Las reglas están en el spec del service.
 */
const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const PDF = Buffer.from('%PDF-1.7\ncontenido');

const ROW = {
  id: DOC,
  type: 'ESTUDIO',
  title: 'Hemograma',
  document_date: null,
  source_institution: null,
  mime_type: 'application/pdf',
  size_bytes: PDF.length,
  uploaded_at: new Date('2026-11-02T15:00:00.000Z'),
};

describe('Documentos del paciente (e2e)', () => {
  let app: INestApplication<App>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let prisma: {
    appointment: { findFirst: jest.Mock };
    clinicalRecordEntry: { findFirst: jest.Mock };
    auditLog: { create: jest.Mock };
    patient: { findUnique: jest.Mock };
    patientDocument: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };
  let upload: jest.Mock;

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    prisma = {
      appointment: { findFirst: jest.fn().mockResolvedValue({ id: 't-1' }) },
      clinicalRecordEntry: { findFirst: jest.fn().mockResolvedValue(null) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      patient: {
        findUnique: jest.fn().mockResolvedValue({ profile_id: PATIENT }),
      },
      patientDocument: {
        create: jest.fn().mockResolvedValue(ROW),
        findMany: jest.fn().mockResolvedValue([ROW]),
        findUnique: jest.fn().mockResolvedValue({
          id: DOC,
          patient_id: PATIENT,
          storage_path: `${PATIENT}/x.pdf`,
          withdrawn_at: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    upload = jest.fn().mockResolvedValue({ error: null });

    const supabase = {
      getClient: () => ({ from: () => ({}), auth: {} }),
      getClientForToken: () => ({
        storage: {
          from: () => ({
            upload,
            createSignedUrl: () =>
              Promise.resolve({
                data: { signedUrl: 'https://x/signed' },
                error: null,
              }),
          }),
        },
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
      .useValue({
        profile: { findUnique: jest.fn() },
        ...legalAcceptedPrismaMock(),
        ...prisma,
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
    return new SignJWT({ email: 'x@test.com', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  it('sin token devuelve 401 y no sube nada', async () => {
    await request(app.getHttpServer())
      .post('/patients/me/documents')
      .field('type', 'ESTUDIO')
      .field('title', 'Hemograma')
      .attach('file', PDF, {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      })
      .expect(401);
    expect(upload).not.toHaveBeenCalled();
  });

  it('sube un PDF con sus datos y devuelve 201', async () => {
    const res = await request(app.getHttpServer())
      .post('/patients/me/documents')
      .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
      .field('type', 'ESTUDIO')
      .field('title', 'Hemograma')
      .field('documentDate', '2026-09-10')
      .field('sourceInstitution', '')
      .attach('file', PDF, {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(res.body).toMatchObject({ id: DOC, type: 'ESTUDIO' });
    expect(upload).toHaveBeenCalled();
  });

  it('un tipo de documento inválido da 400 y no sube nada', async () => {
    await request(app.getHttpServer())
      .post('/patients/me/documents')
      .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
      .field('type', 'RADIOGRAFIA')
      .field('title', 'Placa')
      .attach('file', PDF, {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it('sin archivo da 400', async () => {
    await request(app.getHttpServer())
      .post('/patients/me/documents')
      .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
      .field('type', 'ESTUDIO')
      .field('title', 'Hemograma')
      .expect(400);
  });

  it('GET patients/me/documents lista los propios (me no se toma como id)', async () => {
    const res = await request(app.getHttpServer())
      .get('/patients/me/documents')
      .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
  });

  it('un profesional con turno lista los del paciente', async () => {
    await request(app.getHttpServer())
      .get(`/patients/${PATIENT}/documents`)
      .set('Authorization', `Bearer ${await signToken(PROFESSIONAL)}`)
      .expect(200);
  });

  it('un profesional sin relación recibe 403', async () => {
    prisma.appointment.findFirst.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/patients/${PATIENT}/documents`)
      .set('Authorization', `Bearer ${await signToken(PROFESSIONAL)}`)
      .expect(403);
  });

  it('la descarga devuelve una URL firmada y audita al profesional', async () => {
    const res = await request(app.getHttpServer())
      .get(`/patient-documents/${DOC}/download`)
      .set('Authorization', `Bearer ${await signToken(PROFESSIONAL)}`)
      .expect(200);
    expect(res.body.url).toBe('https://x/signed');
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('retirar un documento propio devuelve 204', async () => {
    await request(app.getHttpServer())
      .delete(`/patients/me/documents/${DOC}`)
      .set('Authorization', `Bearer ${await signToken(PATIENT)}`)
      .expect(204);
    expect(prisma.patientDocument.update).toHaveBeenCalled();
  });
});
