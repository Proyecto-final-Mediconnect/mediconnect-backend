import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { ClinicalDataCipher } from './../src/common/crypto/clinical-data-cipher';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';
import { legalAcceptedPrismaMock } from './legal-accepted.mock';
import { encryptingCipher } from './memory-key-store';

/**
 * ENG-216, parte 2 — un documento del paciente cifrado, de punta a punta por
 * HTTP: se sube, se pide el link de descarga como siempre y el link del backend
 * devuelve el archivo original. Storage está en memoria; lo que se guarda ahí
 * es lo que mandó el backend, así que se ve que llega cifrado.
 */
const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const DOC = '33333333-3333-4333-8333-333333333333';
const PDF = Buffer.from('%PDF-1.7\nTomografía de tórax sin contraste');

describe('Archivos cifrados (e2e)', () => {
  let app: NestExpressApplication;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let objects: Map<string, Buffer>;
  let stored: { storage_path: string; mime_type: string } | null;

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    objects = new Map();
    stored = null;

    const bucket = {
      upload: (path: string, body: Buffer) => {
        objects.set(path, Buffer.from(body));
        return Promise.resolve({ error: null });
      },
      download: (path: string) => {
        const bytes = objects.get(path);
        return Promise.resolve(
          bytes
            ? { data: new Blob([new Uint8Array(bytes)]), error: null }
            : { data: null, error: { message: 'Object not found' } },
        );
      },
      createSignedUrl: () =>
        Promise.resolve({
          data: { signedUrl: 'https://storage/firmada' },
          error: null,
        }),
    };
    const supabase = {
      getClient: () => ({ from: () => ({}), auth: {} }),
      getClientForToken: () => ({ storage: { from: () => bucket } }),
      getServiceClient: () => ({ storage: { from: () => bucket } }),
      getJWKS: () => publicKey,
      getIssuer: () => ISSUER,
    };

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabase)
      .overrideProvider(ClinicalDataCipher)
      .useValue(encryptingCipher())
      .overrideProvider(PrismaService)
      .useValue({
        profile: { findUnique: jest.fn() },
        ...legalAcceptedPrismaMock(),
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        patient: {
          findUnique: jest.fn().mockResolvedValue({ profile_id: PATIENT }),
        },
        patientDocument: {
          aggregate: jest.fn().mockResolvedValue({
            _count: { _all: 0 },
            _sum: { size_bytes: null },
          }),
          create: jest.fn(
            ({
              data,
            }: {
              data: { storage_path: string; mime_type: string };
            }) => {
              stored = data;
              return Promise.resolve({
                id: DOC,
                type: 'ESTUDIO',
                title: 'Tomografía',
                document_date: null,
                source_institution: null,
                mime_type: data.mime_type,
                size_bytes: PDF.length,
                uploaded_at: new Date('2026-11-22T12:00:00.000Z'),
              });
            },
          ),
          findUnique: jest.fn(() =>
            Promise.resolve(
              stored && {
                id: DOC,
                patient_id: PATIENT,
                storage_path: stored.storage_path,
                mime_type: stored.mime_type,
                withdrawn_at: null,
              },
            ),
          ),
        },
      })
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

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

  async function uploadAndLink(): Promise<string> {
    const auth = `Bearer ${await signToken(PATIENT)}`;
    await http()
      .post('/patients/me/documents')
      .set('Authorization', auth)
      .field('type', 'ESTUDIO')
      .field('title', 'Tomografía')
      .attach('file', PDF, {
        filename: 'tomografia.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const res = await http()
      .get(`/patient-documents/${DOC}/download`)
      .set('Authorization', auth)
      .expect(200);
    return (res.body as { url: string }).url;
  }

  it('lo que llega a Storage está cifrado, y el link del backend devuelve el original', async () => {
    const url = await uploadAndLink();

    const [[path, body]] = [...objects];
    expect(path).toMatch(/\.pdf\.enc$/);
    expect(body.includes(Buffer.from('Tomografía'))).toBe(false);

    // La URL apunta al propio backend, como la pidió el cliente.
    const { pathname, search } = new URL(url);
    expect(pathname).toBe('/files');
    expect(url).not.toContain(PATIENT);

    // Sin token: el link es la credencial, como una URL firmada de Storage.
    const res = await http()
      .get(`${pathname}${search}`)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect((res.body as Buffer).equals(PDF)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="documento.pdf"',
    );
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; sandbox",
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('el link no queda en el log de requests', async () => {
    const url = await uploadAndLink();
    const log = jest.spyOn(Logger.prototype, 'log');
    const { pathname, search } = new URL(url);

    await http().get(`${pathname}${search}`).expect(200);

    const token = new URL(url).searchParams.get('t')!;
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('GET /files 200');
    expect(logged).not.toContain(token.slice(0, 20));
  });

  it('sin link, con uno alterado o con basura: 404', async () => {
    const url = await uploadAndLink();
    const token = new URL(url).searchParams.get('t')!;
    const alterado = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;

    await http().get('/files').expect(404);
    await http().get('/files?t=basura').expect(404);
    await http()
      .get(`/files?t=${encodeURIComponent(alterado)}`)
      .expect(404);
    await http()
      .get(`/files?t=${'a'.repeat(5000)}`)
      .expect(404);
  });
});
