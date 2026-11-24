import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClinicalDataCipher } from '../common/crypto/clinical-data-cipher';
import type { PrismaService } from '../prisma/prisma.service';
import { StoredFilesService } from '../stored-files/stored-files.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { encryptingCipher } from '../../test/memory-key-store';
import type { ClinicalRecordsService } from './clinical-records.service';
import {
  IPS_MIME_TYPE,
  PatientDocumentsService,
} from './patient-documents.service';

/**
 * ENG-246 (ADR-022) — el resumen de salud IPS que trae el paciente se guarda
 * como un documento más de los que aporta, y se lee ordenado.
 */

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';

/** El ejemplo oficial de SALUD-AR (Apache 2.0). Trae el DNI 99999999. */
const IPS = readFileSync(
  join(__dirname, '../../test/fixtures/ips-argentina-ejemplo.json'),
);
const SHA = createHash('sha256').update(IPS).digest('hex');

const ROW = {
  id: DOC,
  type: 'INFORME' as const,
  title: 'Resumen de salud',
  document_date: null,
  source_institution: 'Hospital Pintos',
  mime_type: IPS_MIME_TYPE,
  size_bytes: IPS.length,
  uploaded_at: new Date('2026-11-24T15:00:00.000Z'),
};

const dto = {
  type: 'INFORME' as const,
  title: 'Resumen de salud',
  sourceInstitution: 'Hospital Pintos',
};

/** Lo que devuelve `download` de Storage. */
const blob = (bytes: Buffer) => ({
  arrayBuffer: () =>
    Promise.resolve(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ),
});

describe('PatientDocumentsService — resumen de salud IPS (ENG-246)', () => {
  let prisma: {
    patient: { findUnique: jest.Mock };
    patientDocument: {
      create: jest.Mock;
      findUnique: jest.Mock;
      aggregate: jest.Mock;
    };
    auditLog: { create: jest.Mock };
  };
  let storage: { upload: jest.Mock; download: jest.Mock };
  let records: { assertCanReadFor: jest.Mock };
  let supabase: SupabaseService;

  function crear(cipher = new ClinicalDataCipher({} as PrismaService, null)) {
    return new PatientDocumentsService(
      prisma as unknown as PrismaService,
      supabase,
      records as unknown as ClinicalRecordsService,
      new StoredFilesService(supabase, cipher),
    );
  }

  beforeEach(() => {
    prisma = {
      patient: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ profile_id: PATIENT, dni: '99.999.999' }),
      },
      patientDocument: {
        create: jest.fn().mockResolvedValue(ROW),
        findUnique: jest.fn().mockResolvedValue({
          id: DOC,
          patient_id: PATIENT,
          storage_path: `${PATIENT}/abc.json`,
          mime_type: IPS_MIME_TYPE,
          sha256: SHA,
          withdrawn_at: null,
        }),
        aggregate: jest.fn().mockResolvedValue({
          _count: { _all: 0 },
          _sum: { size_bytes: null },
        }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    storage = {
      upload: jest.fn().mockResolvedValue({ error: null }),
      download: jest.fn().mockResolvedValue({ data: blob(IPS), error: null }),
    };
    records = { assertCanReadFor: jest.fn().mockResolvedValue(undefined) };
    supabase = {
      getClientForToken: () => ({ storage: { from: () => storage } }),
      getServiceClient: () => ({ storage: { from: () => storage } }),
    } as unknown as SupabaseService;
  });

  const archivo = (buffer: Buffer, mimetype = 'application/json') => ({
    buffer,
    mimetype,
    size: buffer.length,
  });

  describe('subirlo', () => {
    it('se guarda como documento, con su tipo propio y su SHA-256', async () => {
      await crear().upload(PATIENT, archivo(IPS), dto);

      const [path, , opciones] = storage.upload.mock.calls[0] as [
        string,
        Buffer,
        { contentType: string },
      ];
      expect(path).toMatch(new RegExp(`^${PATIENT}/[0-9a-f-]{36}\\.json$`));
      expect(opciones.contentType).toBe(IPS_MIME_TYPE);
      expect(prisma.patientDocument.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            mime_type: IPS_MIME_TYPE,
            sha256: SHA,
            type: 'INFORME',
          }),
        }),
      );
    });

    it('acepta también `application/fhir+json`', async () => {
      await crear().upload(PATIENT, archivo(IPS, IPS_MIME_TYPE), dto);

      expect(storage.upload).toHaveBeenCalled();
    });

    it('si el paciente todavía no cargó su DNI, entra igual', async () => {
      prisma.patient.findUnique.mockResolvedValue({
        profile_id: PATIENT,
        dni: null,
      });

      await crear().upload(PATIENT, archivo(IPS), dto);

      expect(storage.upload).toHaveBeenCalled();
    });

    it('el resumen de otra persona no entra a su historia', async () => {
      prisma.patient.findUnique.mockResolvedValue({
        profile_id: PATIENT,
        dni: '30418992',
      });

      await expect(crear().upload(PATIENT, archivo(IPS), dto)).rejects.toThrow(
        /El DNI de este resumen de salud no es el tuyo/,
      );
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('un JSON que no es un resumen IPS se rechaza sin subir nada', async () => {
      await expect(
        crear().upload(
          PATIENT,
          archivo(Buffer.from('{"resourceType":"Patient"}')),
          dto,
        ),
      ).rejects.toThrow(/no es un resumen de salud IPS/);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('un archivo que no es JSON se rechaza', async () => {
      await expect(
        crear().upload(PATIENT, archivo(Buffer.from('%PDF-1.7')), dto),
      ).rejects.toThrow(/tiene que ser un JSON válido/);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('más de 1 MB no es un resumen', async () => {
      const grande = Buffer.alloc(1024 * 1024 + 1, 0x20);

      await expect(
        crear().upload(PATIENT, archivo(grande), dto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.upload).not.toHaveBeenCalled();
    });
  });

  describe('leerlo ordenado', () => {
    it('el paciente lee el suyo, sin el DNI del documento, y queda registrado', async () => {
      const resumen = await crear().ipsSummary(PATIENT, DOC);

      expect(resumen.documento).toEqual({
        titulo: 'Resumen del paciente al 26 de Enero de 2018, 14:30hs',
        fecha: '2018-01-26T14:30:00-03:00',
      });
      expect(resumen.propuesta.allergies).toEqual([
        { que: 'alergia a la penicilina', gravedad: 'Grave' },
      ]);
      expect(JSON.stringify(resumen)).not.toContain('99999999');
      expect(records.assertCanReadFor).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: PATIENT,
          action: 'PATIENT_DOCUMENT_VIEW',
          resource_id: DOC,
        }),
      });
    });

    it('un profesional pasa por las reglas de la HC y queda auditado', async () => {
      await crear().ipsSummary(PRO, DOC);

      expect(records.assertCanReadFor).toHaveBeenCalledWith(PRO, PATIENT);
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: PRO,
          action: 'PATIENT_DOCUMENT_VIEW',
          metadata: { patientId: PATIENT },
        }),
      });
    });

    it('un profesional sin relación no lo lee ni lo baja', async () => {
      records.assertCanReadFor.mockRejectedValue(new ForbiddenException());

      await expect(crear().ipsSummary(PRO, DOC)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(storage.download).not.toHaveBeenCalled();
    });

    it('si no se puede auditar al profesional, no se muestra', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('db'));

      await expect(crear().ipsSummary(PRO, DOC)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(storage.download).not.toHaveBeenCalled();
    });

    it('un PDF no es un resumen de salud', async () => {
      prisma.patientDocument.findUnique.mockResolvedValue({
        id: DOC,
        patient_id: PATIENT,
        storage_path: `${PATIENT}/abc.pdf`,
        mime_type: 'application/pdf',
        sha256: SHA,
        withdrawn_at: null,
      });

      await expect(crear().ipsSummary(PATIENT, DOC)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('un documento retirado da 404', async () => {
      prisma.patientDocument.findUnique.mockResolvedValue({
        id: DOC,
        patient_id: PATIENT,
        storage_path: `${PATIENT}/abc.json`,
        mime_type: IPS_MIME_TYPE,
        sha256: SHA,
        withdrawn_at: new Date(),
      });

      await expect(crear().ipsSummary(PATIENT, DOC)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('si el archivo no es el que se subió (otro SHA-256), no se muestra', async () => {
      storage.download.mockResolvedValue({
        data: blob(Buffer.from(IPS.toString('utf8').replace('asma', 'nada'))),
        error: null,
      });

      await expect(crear().ipsSummary(PATIENT, DOC)).rejects.toThrow(
        /no coincide con el que se subió/,
      );
    });

    it('con el cifrado prendido, se sube cifrado y se lee descifrado', async () => {
      const servicio = crear(encryptingCipher());
      await servicio.upload(PATIENT, archivo(IPS), dto);
      const [path, cuerpo] = storage.upload.mock.calls[0] as [string, Buffer];
      expect(path).toMatch(/\.json\.enc$/);
      expect(cuerpo.includes(Buffer.from('penicilina'))).toBe(false);

      prisma.patientDocument.findUnique.mockResolvedValue({
        id: DOC,
        patient_id: PATIENT,
        storage_path: path,
        mime_type: IPS_MIME_TYPE,
        sha256: SHA,
        withdrawn_at: null,
      });
      storage.download.mockResolvedValue({ data: blob(cuerpo), error: null });

      const resumen = await servicio.ipsSummary(PATIENT, DOC);
      expect(resumen.propuesta.conditions).toEqual([
        { nombre: 'asma', codigo: 'SNOMED 195967001' },
      ]);
    });
  });
});
