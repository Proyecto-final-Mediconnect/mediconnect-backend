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

const FICHA = {
  first_name: 'Marina',
  last_name: 'López',
  birth_date: new Date('1985-03-10'),
  sex: 'F',
  blood_type: 'A+',
  allergies: [{ que: 'Penicilina', gravedad: 'Anafilaxia' }],
  medications: [{ droga: 'Enalapril', dosis: '10 mg' }],
  conditions: [{ nombre: 'Hipertensión', codigo: 'I10' }],
  emergency_contact: { nombre: 'Juan', vinculo: 'Hermano', telefono: '1155' },
};

/** ENG-191 — los datos vitales del paciente para la videoconsulta. */
describe('ClinicalRecordsService.readPatientVital', () => {
  let prisma: {
    appointment: { findFirst: jest.Mock };
    clinicalRecordEntry: { findFirst: jest.Mock };
    patient: { findUnique: jest.Mock };
    auditLog: { create: jest.Mock };
  };
  let service: ClinicalRecordsService;

  beforeEach(() => {
    prisma = {
      appointment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'turno-1' }),
      },
      clinicalRecordEntry: { findFirst: jest.fn().mockResolvedValue(null) },
      patient: { findUnique: jest.fn().mockResolvedValue(FICHA) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    service = new ClinicalRecordsService(
      prisma as unknown as PrismaService,
      {} as SupabaseService,
    );
  });

  it('el profesional con turno ve alergias, medicación y condiciones, sin el contacto', async () => {
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

  it('cada lectura queda auditada', async () => {
    await service.readPatientVital(PROFESSIONAL, PATIENT, NOW);

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actor_id: PROFESSIONAL,
        action: 'PATIENT_VITAL_READ',
        resource_type: 'patients',
        resource_id: PATIENT,
        metadata: { role: 'PROFESIONAL' },
      },
    });
  });

  it('sin relación con el paciente da 403 y no lee nada', async () => {
    prisma.appointment.findFirst.mockResolvedValue(null);

    await expect(
      service.readPatientVital(PROFESSIONAL, PATIENT, NOW),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.patient.findUnique).not.toHaveBeenCalled();
  });

  it('el paciente ve lo suyo sin relación que validar', async () => {
    await service.readPatientVital(PATIENT, PATIENT, NOW);
    expect(prisma.appointment.findFirst).not.toHaveBeenCalled();
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
