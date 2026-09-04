import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  computeContentHash,
  GENESIS_HASH,
} from '../common/hash-chain/hash-chain';
import {
  ClinicalRecordsService,
  type NewClinicalEntry,
} from './clinical-records.service';

/**
 * Escritura y lectura de la HC (ENG-57).
 *
 * Prisma y Supabase van mockeados: acá se verifica el sellado (qué hash se
 * calcula y contra qué cabeza), el reintento ante colisión y el mapeo de salida.
 * Que la base rechace de verdad un UPDATE o una cadena rota lo cubre
 * `test/clinical-records.integration.spec.ts` contra Postgres real.
 *
 * Todos los recursos FHIR son sintéticos.
 */

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-27T12:00:00.000Z');

function newEntry(overrides: Partial<NewClinicalEntry> = {}): NewClinicalEntry {
  return {
    patientId: PATIENT,
    professionalId: PROFESSIONAL,
    entryType: 'CONSULTA',
    fhirResourceType: 'Observation',
    content: {
      resourceType: 'Observation',
      status: 'final',
      valueQuantity: { value: 70, unit: '/min' },
    },
    ...overrides,
  };
}

/** Argumentos con los que el service llama a `prisma.clinicalRecordEntry.create`. */
type CreateArgs = { data: Record<string, unknown> };

/** Devuelve la fila que Prisma "guardó", a partir de lo que recibió. */
function rowFromCreate(args: CreateArgs) {
  return {
    id: 'entry-1',
    ...args.data,
    sequence_number: BigInt(args.data.sequence_number as number),
  };
}

describe('ClinicalRecordsService', () => {
  let service: ClinicalRecordsService;
  let prisma: {
    appointment: { findFirst: jest.Mock };
    clinicalRecordEntry: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
    };
  };
  let order: jest.Mock;

  beforeEach(() => {
    prisma = {
      appointment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'turno-1' }),
      },
      clinicalRecordEntry: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementation((args: CreateArgs) => rowFromCreate(args)),
      },
    };

    order = jest.fn().mockResolvedValue({ data: [], error: null });
    const supabase = {
      getClientForToken: () => ({
        from: () => ({ select: () => ({ eq: () => ({ order }) }) }),
      }),
    } as unknown as SupabaseService;

    service = new ClinicalRecordsService(
      prisma as unknown as PrismaService,
      supabase,
    );
  });

  describe('headOf', () => {
    it('una cadena vacía arranca en el génesis y secuencia 0', async () => {
      await expect(service.headOf(PATIENT)).resolves.toEqual({
        hash: GENESIS_HASH,
        sequenceNumber: 0,
      });
    });

    it('devuelve el último hash y su número', async () => {
      prisma.clinicalRecordEntry.findFirst.mockResolvedValue({
        sequence_number: BigInt(7),
        content_hash: 'a'.repeat(64),
      });

      await expect(service.headOf(PATIENT)).resolves.toEqual({
        hash: 'a'.repeat(64),
        sequenceNumber: 7,
      });
    });
  });

  describe('append', () => {
    it('la primera entrada encadena contra el génesis con secuencia 1', async () => {
      const view = await service.append(newEntry(), NOW);

      expect(view.sequenceNumber).toBe(1);
      expect(view.previousHash).toBe(GENESIS_HASH);
    });

    it('la siguiente encadena contra la cabeza actual', async () => {
      const headHash = 'b'.repeat(64);
      prisma.clinicalRecordEntry.findFirst.mockResolvedValue({
        sequence_number: BigInt(4),
        content_hash: headHash,
      });

      const view = await service.append(newEntry(), NOW);

      expect(view.sequenceNumber).toBe(5);
      expect(view.previousHash).toBe(headHash);
    });

    it('el hash guardado es el de la preimagen, recalculable desde la fila', async () => {
      // Si esto se rompe, el job de ENG-85 reporta la entrada como manipulada
      // apenas se guarda.
      const view = await service.append(newEntry(), NOW);

      const recomputed = computeContentHash(
        {
          patientId: view.patientId,
          professionalId: view.professionalId,
          sequenceNumber: view.sequenceNumber,
          entryType: view.entryType,
          fhirResourceType: view.fhirResourceType,
          content: view.content,
          consultationId: view.consultationId,
          correctsEntryId: view.correctsEntryId,
          createdAt: new Date(view.createdAt),
        },
        view.previousHash,
      );

      expect(view.contentHash).toBe(recomputed);
    });

    it('guarda el mismo timestamp que hasheó', async () => {
      // Tomar la hora dos veces produciría un hash que no corresponde a la fila.
      await service.append(newEntry(), NOW);

      const saved = prisma.clinicalRecordEntry.create.mock.calls[0][0].data;
      expect((saved.created_at as Date).toISOString()).toBe(NOW.toISOString());
    });

    it('el profesional que firma sale del parámetro, no del contenido', async () => {
      const view = await service.append(newEntry(), NOW);

      expect(view.professionalId).toBe(PROFESSIONAL);
    });

    it('una corrección apunta a la entrada corregida y no la modifica', async () => {
      const view = await service.append(
        newEntry({ entryType: 'CORRECCION', correctsEntryId: 'vieja-1' }),
        NOW,
      );

      expect(view.entryType).toBe('CORRECCION');
      expect(view.correctsEntryId).toBe('vieja-1');
      // Se agrega una fila nueva: nunca se actualiza la anterior.
      expect(prisma.clinicalRecordEntry.create).toHaveBeenCalledTimes(1);
    });

    it('reintenta con la cabeza nueva cuando otro escribió en el medio', async () => {
      // El `for update` del trigger no evita el duplicado: lo evita la unique, y
      // por eso el reintento no es opcional (hallazgo de ENG-45).
      prisma.clinicalRecordEntry.findFirst
        .mockResolvedValueOnce({
          sequence_number: BigInt(1),
          content_hash: 'c'.repeat(64),
        })
        .mockResolvedValueOnce({
          sequence_number: BigInt(2),
          content_hash: 'd'.repeat(64),
        });
      prisma.clinicalRecordEntry.create
        .mockRejectedValueOnce({ code: 'P2002' })
        .mockImplementationOnce((args: CreateArgs) => rowFromCreate(args));

      const view = await service.append(newEntry(), NOW);

      expect(view.sequenceNumber).toBe(3);
      expect(view.previousHash).toBe('d'.repeat(64));
    });

    it('se rinde con 409 después de tres colisiones seguidas', async () => {
      prisma.clinicalRecordEntry.create.mockRejectedValue({ code: 'P2002' });

      await expect(service.append(newEntry(), NOW)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.clinicalRecordEntry.create).toHaveBeenCalledTimes(3);
    });

    it('un error que no es colisión no se reintenta', async () => {
      // Reintentar un fallo de base tres veces solo demora el error.
      prisma.clinicalRecordEntry.create.mockRejectedValue({ code: 'P1001' });

      await expect(service.append(newEntry(), NOW)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(prisma.clinicalRecordEntry.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('listForPatient', () => {
    it('pide las entradas ordenadas por secuencia, no por fecha', async () => {
      // Dos entradas pueden compartir el milisegundo; la secuencia es la que
      // define la cadena.
      await service.listForPatient('jwt', PATIENT);

      expect(order).toHaveBeenCalledWith('sequence_number', {
        ascending: true,
      });
    });

    it('propaga el fallo de la base como 500 sin filtrar el detalle', async () => {
      order.mockResolvedValue({ data: null, error: { message: 'boom' } });

      await expect(service.listForPatient('jwt', PATIENT)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('una HC vacía es una lista vacía, no un error', async () => {
      await expect(service.listForPatient('jwt', PATIENT)).resolves.toEqual([]);
    });
  });

  describe('addEntryAsProfessional (ENG-58)', () => {
    const form = {
      entryType: 'CONSULTA' as const,
      reason: 'Control de rutina',
      diagnosis: 'Sin hallazgos',
    };

    it('sella la entrada con el profesional del JWT', async () => {
      const view = await service.addEntryAsProfessional(
        PROFESSIONAL,
        PATIENT,
        form,
        NOW,
      );

      expect(view.professionalId).toBe(PROFESSIONAL);
      expect(view.patientId).toBe(PATIENT);
      expect(view.sequenceNumber).toBe(1);
    });

    it('guarda el contenido como recurso FHIR', async () => {
      const view = await service.addEntryAsProfessional(
        PROFESSIONAL,
        PATIENT,
        form,
        NOW,
      );

      expect(view.fhirResourceType).toBe('ClinicalImpression');
      expect(view.content).toMatchObject({
        resourceType: 'ClinicalImpression',
        description: 'Control de rutina',
      });
    });

    it('el recurso y la fila comparten el instante exacto', async () => {
      // Si se tomaran por separado, el `date` del recurso y el `created_at` de la
      // fila dirían dos cosas distintas sobre cuándo se escribió el asiento.
      const view = await service.addEntryAsProfessional(
        PROFESSIONAL,
        PATIENT,
        form,
        NOW,
      );

      expect((view.content as { date: string }).date).toBe(view.createdAt);
    });

    it('rechaza a un profesional que nunca atendió a ese paciente', async () => {
      // La tabla es append-only: un asiento escrito por error NO se puede borrar.
      prisma.appointment.findFirst.mockResolvedValue(null);

      await expect(
        service.addEntryAsProfessional(PROFESSIONAL, PATIENT, form, NOW),
      ).rejects.toThrow(ForbiddenException);
    });

    it('no escribe nada cuando rechaza por autorización', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);

      await expect(
        service.addEntryAsProfessional(PROFESSIONAL, PATIENT, form, NOW),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.clinicalRecordEntry.create).not.toHaveBeenCalled();
    });

    it('acepta un turno cancelado o pasado', async () => {
      // "Durante y después de la consulta": quien atendió hace un mes sigue
      // teniendo que poder ampliar el registro.
      prisma.appointment.findFirst.mockResolvedValue({ id: 'turno-viejo' });

      await expect(
        service.addEntryAsProfessional(PROFESSIONAL, PATIENT, form, NOW),
      ).resolves.toMatchObject({ sequenceNumber: 1 });
      // El filtro no mira el estado del turno, solo la relación.
      const where = prisma.appointment.findFirst.mock.calls[0][0].where;
      expect(where).not.toHaveProperty('status');
    });

    it('encadena contra la cabeza existente de esa HC', async () => {
      prisma.clinicalRecordEntry.findFirst.mockResolvedValue({
        sequence_number: BigInt(3),
        content_hash: 'e'.repeat(64),
      });

      const view = await service.addEntryAsProfessional(
        PROFESSIONAL,
        PATIENT,
        form,
        NOW,
      );

      expect(view.sequenceNumber).toBe(4);
      expect(view.previousHash).toBe('e'.repeat(64));
    });
  });

  describe('verifyPatientChain', () => {
    it('una cadena vacía es válida y su cabeza es el génesis', async () => {
      await expect(service.verifyPatientChain(PATIENT)).resolves.toEqual({
        valid: true,
        entries: 0,
        headHash: GENESIS_HASH,
      });
    });

    it('detecta una entrada con el contenido alterado', async () => {
      const sealed = await service.append(newEntry(), NOW);
      prisma.clinicalRecordEntry.findMany.mockResolvedValue([
        {
          patient_id: sealed.patientId,
          professional_id: sealed.professionalId,
          sequence_number: BigInt(1),
          entry_type: sealed.entryType,
          fhir_resource_type: sealed.fhirResourceType,
          content: { resourceType: 'Observation', status: 'final' },
          consultation_id: null,
          corrects_entry_id: null,
          created_at: NOW,
          content_hash: sealed.contentHash,
          previous_hash: sealed.previousHash,
        },
      ]);

      const result = await service.verifyPatientChain(PATIENT);

      expect(result.valid).toBe(false);
      expect(result).toMatchObject({
        failure: { sequenceNumber: 1, reason: 'CONTENT_TAMPERED' },
      });
    });
  });
});
