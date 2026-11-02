import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ClinicalRecordsService } from './clinical-records.service';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  PATIENT_DOCUMENTS_BUCKET,
  PatientDocumentsService,
} from './patient-documents.service';

/** ENG-164 — documentación clínica previa que aporta el paciente. */

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'token';

const PDF = Buffer.from('%PDF-1.7\n...contenido...');
const ROW = {
  id: DOC,
  type: 'ESTUDIO' as const,
  title: 'Hemograma',
  document_date: new Date('2026-09-10T00:00:00.000Z'),
  source_institution: 'Hospital Privado',
  mime_type: 'application/pdf',
  size_bytes: PDF.length,
  uploaded_at: new Date('2026-11-02T15:00:00.000Z'),
};
const STORED = {
  id: DOC,
  patient_id: PATIENT,
  storage_path: `${PATIENT}/abc.pdf`,
  withdrawn_at: null,
};

describe('PatientDocumentsService', () => {
  let service: PatientDocumentsService;
  let prisma: {
    patient: { findUnique: jest.Mock };
    patientDocument: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    auditLog: { create: jest.Mock };
  };
  let storage: { upload: jest.Mock; createSignedUrl: jest.Mock };
  let from: jest.Mock;
  let records: { assertCanReadFor: jest.Mock };

  beforeEach(() => {
    prisma = {
      patient: {
        findUnique: jest.fn().mockResolvedValue({ profile_id: PATIENT }),
      },
      patientDocument: {
        create: jest.fn().mockResolvedValue(ROW),
        findMany: jest.fn().mockResolvedValue([ROW]),
        findUnique: jest.fn().mockResolvedValue(STORED),
        update: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    storage = {
      upload: jest.fn().mockResolvedValue({ error: null }),
      createSignedUrl: jest.fn().mockResolvedValue({
        data: { signedUrl: 'https://x/signed' },
        error: null,
      }),
    };
    from = jest.fn().mockReturnValue(storage);
    records = { assertCanReadFor: jest.fn().mockResolvedValue(undefined) };
    service = new PatientDocumentsService(
      prisma as unknown as PrismaService,
      {
        getClientForToken: () => ({ storage: { from } }),
      } as unknown as SupabaseService,
      records as unknown as ClinicalRecordsService,
    );
  });

  const file = (buffer = PDF, mimetype = 'application/pdf') => ({
    buffer,
    mimetype,
    size: buffer.length,
  });
  const dto = {
    type: 'ESTUDIO' as const,
    title: 'Hemograma',
    documentDate: '2026-09-10',
    sourceInstitution: 'Hospital Privado',
  };

  describe('upload', () => {
    it('guarda el archivo en el bucket privado y su SHA-256 en la tabla', async () => {
      const view = await service.upload(TOKEN, PATIENT, file(), dto);

      expect(from).toHaveBeenCalledWith(PATIENT_DOCUMENTS_BUCKET);
      const [path] = storage.upload.mock.calls[0] as [string];
      // La carpeta es el paciente y el nombre es aleatorio, sin el original.
      expect(path).toMatch(new RegExp(`^${PATIENT}/[0-9a-f-]{36}\\.pdf$`));
      expect(prisma.patientDocument.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            patient_id: PATIENT,
            storage_path: path,
            sha256: createHash('sha256').update(PDF).digest('hex'),
            mime_type: 'application/pdf',
            size_bytes: PDF.length,
          }),
        }),
      );
      expect(view).toEqual({
        id: DOC,
        type: 'ESTUDIO',
        title: 'Hemograma',
        documentDate: '2026-09-10',
        sourceInstitution: 'Hospital Privado',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
        uploadedAt: '2026-11-02T15:00:00.000Z',
      });
    });

    it('rechaza un tipo que no es PDF, JPG ni PNG', async () => {
      await expect(
        service.upload(TOKEN, PATIENT, file(PDF, 'application/zip'), dto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    // El Content-Type lo pone el cliente: se mira el contenido.
    it('rechaza un archivo que dice ser PDF y no lo es', async () => {
      await expect(
        service.upload(TOKEN, PATIENT, file(Buffer.from('MZ\x90\x00')), dto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza más de 10 MB', async () => {
      const grande = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
      await expect(
        service.upload(TOKEN, PATIENT, file(grande), dto),
      ).rejects.toThrow('10 MB');
    });

    it('sin perfil de paciente pide completarlo', async () => {
      prisma.patient.findUnique.mockResolvedValue(null);

      await expect(
        service.upload(TOKEN, PATIENT, file(), dto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('si Storage falla, no guarda la fila', async () => {
      storage.upload.mockResolvedValue({ error: { message: 'boom' } });

      await expect(
        service.upload(TOKEN, PATIENT, file(), dto),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(prisma.patientDocument.create).not.toHaveBeenCalled();
    });
  });

  describe('listFor', () => {
    it('el paciente ve los suyos sin chequeo de relación', async () => {
      await expect(service.listFor(PATIENT, PATIENT)).resolves.toHaveLength(1);
      expect(records.assertCanReadFor).not.toHaveBeenCalled();
      expect(prisma.patientDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { patient_id: PATIENT, withdrawn_at: null },
        }),
      );
    });

    it('un profesional pasa por las reglas de la HC', async () => {
      await service.listFor(PRO, PATIENT);
      expect(records.assertCanReadFor).toHaveBeenCalledWith(PRO, PATIENT);
    });

    it('un profesional sin relación recibe 403', async () => {
      records.assertCanReadFor.mockRejectedValue(new ForbiddenException());
      await expect(service.listFor(PRO, PATIENT)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.patientDocument.findMany).not.toHaveBeenCalled();
    });
  });

  describe('downloadUrl', () => {
    it('al profesional con acceso le da una URL firmada corta y lo audita', async () => {
      const result = await service.downloadUrl(PRO, TOKEN, DOC);

      expect(storage.createSignedUrl).toHaveBeenCalledWith(
        STORED.storage_path,
        DOWNLOAD_URL_TTL_SECONDS,
      );
      expect(result.url).toBe('https://x/signed');
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: PRO,
          action: 'PATIENT_DOCUMENT_DOWNLOAD',
          resource_type: 'patient_documents',
          resource_id: DOC,
        }),
      });
    });

    it('al profesional sin turno lo frena antes de firmar', async () => {
      records.assertCanReadFor.mockRejectedValue(new ForbiddenException());

      await expect(service.downloadUrl(PRO, TOKEN, DOC)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(storage.createSignedUrl).not.toHaveBeenCalled();
    });

    // Falla cerrado, como la lectura de la HC.
    it('si no se puede auditar, no entrega la URL', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('db'));

      await expect(service.downloadUrl(PRO, TOKEN, DOC)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(storage.createSignedUrl).not.toHaveBeenCalled();
    });

    it('el paciente abre lo suyo sin dejar auditoría de profesional', async () => {
      await service.downloadUrl(PATIENT, TOKEN, DOC);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(records.assertCanReadFor).not.toHaveBeenCalled();
    });

    it('un documento retirado da 404', async () => {
      prisma.patientDocument.findUnique.mockResolvedValue({
        ...STORED,
        withdrawn_at: new Date(),
      });
      await expect(
        service.downloadUrl(PATIENT, TOKEN, DOC),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('withdraw', () => {
    it('marca withdrawn_at y nada más', async () => {
      const now = new Date('2026-11-02T16:00:00.000Z');
      await service.withdraw(PATIENT, DOC, now);
      expect(prisma.patientDocument.update).toHaveBeenCalledWith({
        where: { id: DOC },
        data: { withdrawn_at: now },
      });
    });

    it('no deja retirar el documento de otro', async () => {
      await expect(service.withdraw(PRO, DOC)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.patientDocument.update).not.toHaveBeenCalled();
    });
  });
});
