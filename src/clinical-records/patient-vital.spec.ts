import {
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { ClinicalRecordsService } from './clinical-records.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-20T15:00:00.000Z');
/** Turno confirmado de 30 minutos que empieza a la hora de `NOW`. */
const TURNO = {
  scheduled_at: new Date('2026-11-20T15:00:00.000Z'),
  duration_minutes: 30,
};
const minutos = (m: number) => new Date(NOW.getTime() + m * 60_000);

const FICHA = {
  first_name: 'Marina',
  last_name: 'López',
  birth_date: new Date('1985-03-10'),
  sex: 'F',
  blood_type: 'A+',
  allergies: [{ que: 'Penicilina', gravedad: 'Anafilaxia' }],
  medications: [{ droga: 'Enalapril', dosis: '10 mg' }],
  conditions: [{ nombre: 'Hipertensión', codigo: 'I10' }],
};

/** ENG-191 — los datos vitales del paciente para la videoconsulta. */
describe('ClinicalRecordsService.readPatientVital', () => {
  let prisma: {
    appointment: { findMany: jest.Mock };
    patient: { findUnique: jest.Mock };
    auditLog: { create: jest.Mock };
  };
  let service: ClinicalRecordsService;

  beforeEach(() => {
    prisma = {
      appointment: { findMany: jest.fn().mockResolvedValue([TURNO]) },
      patient: { findUnique: jest.fn().mockResolvedValue(FICHA) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    service = new ClinicalRecordsService(
      prisma as unknown as PrismaService,
      {} as SupabaseService,
    );
  });

  it('en la consulta, el profesional ve alergias, medicación y condiciones, sin el contacto', async () => {
    const vital = await service.readPatientVital(PROFESSIONAL, PATIENT, NOW);

    expect(vital).toMatchObject({
      nombre: 'Marina López',
      edad: 41,
      alergias: [{ que: 'Penicilina', gravedad: 'Anafilaxia' }],
      medicacion: [{ droga: 'Enalapril', dosis: '10 mg' }],
      condiciones: [{ nombre: 'Hipertensión', codigo: 'I10' }],
    });
    expect(vital).not.toHaveProperty('contacto');
  });

  it('no trae de la base el contacto de emergencia', async () => {
    await service.readPatientVital(PROFESSIONAL, PATIENT, NOW);

    const [{ select }] = prisma.patient.findUnique.mock.calls[0] as [
      { select: Record<string, boolean> },
    ];
    expect(select).not.toHaveProperty('emergency_contact');
    expect(select).toHaveProperty('allergies', true);
  });

  it('se audita como lectura de la HC: el paciente la ve en su historial (review de #115)', async () => {
    await service.readPatientVital(PROFESSIONAL, PATIENT, NOW);

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actor_id: PROFESSIONAL,
        action: 'CLINICAL_RECORD_READ',
        resource_type: 'clinical_record_entries',
        resource_id: PATIENT,
        metadata: { role: 'PROFESIONAL', scope: 'vital' },
      },
    });
  });

  it('el paciente ve lo suyo sin turno que validar', async () => {
    await service.readPatientVital(PATIENT, PATIENT, NOW);
    expect(prisma.appointment.findMany).not.toHaveBeenCalled();
  });

  describe('solo durante la consulta (review de #115)', () => {
    it('sin un turno confirmado con el paciente da 403 y no lee nada', async () => {
      prisma.appointment.findMany.mockResolvedValue([]);

      await expect(
        service.readPatientVital(PROFESSIONAL, PATIENT, NOW),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.patient.findUnique).not.toHaveBeenCalled();
    });

    it('pide solo turnos confirmados', async () => {
      await service.readPatientVital(PROFESSIONAL, PATIENT, NOW);
      const [{ where }] = prisma.appointment.findMany.mock.calls[0] as [
        { where: { status: string } },
      ];
      expect(where.status).toBe('CONFIRMADO');
    });

    it('desde que abre la sala, 10 minutos antes', async () => {
      await expect(
        service.readPatientVital(PROFESSIONAL, PATIENT, minutos(-10)),
      ).resolves.toBeDefined();
    });

    it('antes de que abra la sala, no', async () => {
      await expect(
        service.readPatientVital(PROFESSIONAL, PATIENT, minutos(-11)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('hasta 24 horas después del final, para cargar la evolución', async () => {
      await expect(
        service.readPatientVital(PROFESSIONAL, PATIENT, minutos(30 + 24 * 60)),
      ).resolves.toBeDefined();
      await expect(
        service.readPatientVital(
          PROFESSIONAL,
          PATIENT,
          minutos(30 + 24 * 60 + 1),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('sin ficha cargada da 404', async () => {
    prisma.patient.findUnique.mockResolvedValue(null);
    await expect(
      service.readPatientVital(PROFESSIONAL, PATIENT, NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('si no se puede auditar, no entrega los datos', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('db'));
    await expect(
      service.readPatientVital(PROFESSIONAL, PATIENT, NOW),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
