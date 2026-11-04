import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DATA_EXPORT_FORMAT, DataExportService } from './data-export.service';

const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-04T12:00:00.000Z');

/** Derecho de acceso (ENG-86): todo lo que se guarda de quien pide, y nada de terceros. */
describe('DataExportService', () => {
  let prisma: Record<string, Record<string, jest.Mock>>;
  let service: DataExportService;

  const vacio = () => jest.fn().mockResolvedValue([]);

  beforeEach(() => {
    prisma = {
      profile: {
        findUnique: jest.fn().mockResolvedValue({
          email: 'marina@test.com',
          role: 'PACIENTE',
          created_at: new Date('2026-07-01T10:00:00.000Z'),
          deleted_at: null,
          email_reminders: true,
        }),
      },
      legalAcceptance: { findMany: vacio() },
      notification: { findMany: vacio() },
      patient: {
        findUnique: jest.fn().mockResolvedValue({
          first_name: 'Marina',
          last_name: 'Ocampo',
          birth_date: new Date('1991-03-02T00:00:00.000Z'),
          dni: '30418992',
          phone: '1155550000',
          address: null,
          sex: 'Femenino',
          blood_type: '0+',
          allergies: [{ que: 'Penicilina', gravedad: 'Anafilaxia' }],
          medications: null,
          conditions: null,
          emergency_contact: null,
          medipass_scope: null,
        }),
      },
      appointment: { findMany: vacio() },
      clinicalRecordEntry: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'e1',
            sequence_number: BigInt(1),
            entry_type: 'CONSULTA',
            fhir_resource_type: 'Encounter',
            content: { motivo: 'Control' },
            corrects_entry_id: null,
            content_hash: 'a'.repeat(64),
            previous_hash: '0'.repeat(64),
            created_at: new Date('2026-09-01T10:00:00.000Z'),
            professional: {
              first_name: 'Pablo',
              last_name: 'Rivas',
              license_number: 'MP 12345',
            },
          },
        ]),
        count: jest.fn().mockResolvedValue(7),
      },
      patientDocument: { findMany: vacio() },
      mediPassSession: { findMany: vacio() },
      review: { findMany: vacio() },
      conversation: { findMany: vacio() },
      auditLog: { findMany: vacio() },
      mediPassEmergencyCard: { findFirst: jest.fn().mockResolvedValue(null) },
      professional: {
        findMany: vacio(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    service = new DataExportService(prisma as unknown as PrismaService);
  });

  it('paciente: cuenta, ficha, datos de emergencia y la HC completa con su hash', async () => {
    const res = await service.export(USER, NOW);

    expect(res.formato).toBe(DATA_EXPORT_FORMAT);
    expect(res.generadoEl).toBe(NOW.toISOString());
    expect(res.cuenta).toEqual(
      expect.objectContaining({ email: 'marina@test.com', rol: 'PACIENTE' }),
    );
    expect(res).toHaveProperty('paciente.dni', '30418992');
    expect(res).toHaveProperty('datosDeEmergencia.grupoSanguineo', '0+');
    expect(res).toHaveProperty('historiaClinica', [
      expect.objectContaining({
        numero: '1',
        profesional: 'Pablo Rivas',
        matricula: 'MP 12345',
        hash: 'a'.repeat(64),
      }),
    ]);
  });

  it('todo se pide filtrado por quien pide', async () => {
    await service.export(USER, NOW);

    expect(prisma.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { patient_id: USER } }),
    );
    expect(prisma.clinicalRecordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { patient_id: USER } }),
    );
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: USER, channel: 'IN_APP' } }),
    );
  });

  it('profesional: sus turnos sin la identidad del paciente, y de las HC solo la cantidad', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      email: 'pablo@test.com',
      role: 'PROFESIONAL',
      created_at: new Date(),
      deleted_at: null,
      email_reminders: true,
    });

    const res = await service.export(USER, NOW);

    const select = prisma.appointment.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty('patient');
    expect(select).not.toHaveProperty('patient_id');
    expect(prisma.clinicalRecordEntry.findMany).not.toHaveBeenCalled();
    expect(res).toHaveProperty('entradasDeHistoriaClinicaFirmadas.cantidad', 7);
  });

  it('una cuenta dada de baja no exporta nada', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      email: 'x',
      role: 'PACIENTE',
      created_at: new Date(),
      deleted_at: new Date(),
      email_reminders: false,
    });

    await expect(service.export(USER, NOW)).rejects.toThrow(NotFoundException);
  });
});
