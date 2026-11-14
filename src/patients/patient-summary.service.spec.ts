import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { PatientSummaryService } from './patient-summary.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-20T15:00:00.000Z');
const pasado = {
  status: 'COMPLETADO',
  scheduled_at: new Date('2026-11-10T15:00:00.000Z'),
};
const futuro = {
  status: 'CONFIRMADO',
  scheduled_at: new Date('2026-11-25T15:00:00.000Z'),
};

/** ENG-198 — el resumen del inicio del paciente. */
describe('PatientSummaryService', () => {
  let prisma: {
    patient: { findUnique: jest.Mock };
    appointment: { findMany: jest.Mock };
    payment: { findMany: jest.Mock };
    mediPassSession: { count: jest.Mock };
    auditLog: { count: jest.Mock };
  };
  let service: PatientSummaryService;

  beforeEach(() => {
    prisma = {
      patient: {
        findUnique: jest.fn().mockResolvedValue({ profile_id: PATIENT }),
      },
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
      payment: { findMany: jest.fn().mockResolvedValue([]) },
      mediPassSession: { count: jest.fn().mockResolvedValue(0) },
      auditLog: { count: jest.fn().mockResolvedValue(0) },
    };
    service = new PatientSummaryService(prisma as unknown as PrismaService);
  });

  it('suma lo pagado y lo reembolsado, y cuenta consultas y profesionales distintos', async () => {
    prisma.appointment.findMany.mockResolvedValue([
      { professional_id: 'ana' },
      { professional_id: 'ana' },
      { professional_id: 'lucia' },
    ]);
    prisma.payment.findMany.mockResolvedValue([
      { amount: '18000.00', appointment: pasado, refunds: [] },
      {
        amount: '18000.00',
        appointment: { status: 'CANCELADO', scheduled_at: NOW },
        refunds: [{ amount: '9000.00' }],
      },
      { amount: '9500.50', appointment: futuro, refunds: [] },
    ]);

    const resumen = await service.summary(PATIENT, {}, NOW);

    expect(resumen.consultas).toEqual({ realizadas: 3, profesionales: 2 });
    expect(resumen.pagos).toEqual({
      pagado: 45500.5,
      reembolsado: 9000,
      neto: 36500.5,
      turnos: 3,
      porVenir: 1,
    });
  });

  it('cuenta los accesos de profesionales con el mismo filtro que el historial', async () => {
    prisma.mediPassSession.count.mockResolvedValue(2);
    prisma.auditLog.count.mockResolvedValue(5);

    const resumen = await service.summary(PATIENT, {}, NOW);

    expect(resumen.accesos).toEqual({
      medipass: 2,
      historiaClinica: 5,
      total: 7,
    });
    const [{ where }] = prisma.auditLog.count.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    // Sus propias lecturas no cuentan.
    expect(where).toMatchObject({
      action: 'CLINICAL_RECORD_READ',
      resource_id: PATIENT,
      NOT: { actor_id: PATIENT },
      metadata: { path: ['role'], equals: 'PROFESIONAL' },
    });
  });

  it('todo se filtra por el paciente del JWT y el período', async () => {
    await service.summary(
      PATIENT,
      { from: '2026-11-01', to: '2026-11-30' },
      NOW,
    );

    const periodo = {
      gte: new Date('2026-11-01T03:00:00.000Z'),
      lt: new Date('2026-12-01T03:00:00.000Z'),
    };
    expect(prisma.appointment.findMany.mock.calls[0][0].where).toEqual({
      patient_id: PATIENT,
      status: 'COMPLETADO',
      scheduled_at: periodo,
    });
    expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({
      status: { in: ['APROBADO', 'REEMBOLSADO'] },
      confirmed_at: periodo,
      appointment: { patient_id: PATIENT },
    });
    expect(prisma.mediPassSession.count.mock.calls[0][0].where).toEqual({
      patient_id: PATIENT,
      started_at: periodo,
    });
  });

  it('sin actividad devuelve todo en cero, y por defecto los últimos 30 días', async () => {
    const resumen = await service.summary(PATIENT, {}, NOW);

    expect(resumen).toEqual({
      from: '2026-10-22',
      to: '2026-11-20',
      currency: 'ARS',
      consultas: { realizadas: 0, profesionales: 0 },
      pagos: { pagado: 0, reembolsado: 0, neto: 0, turnos: 0, porVenir: 0 },
      accesos: { medipass: 0, historiaClinica: 0, total: 0 },
    });
  });

  it('quien no es paciente recibe 403', async () => {
    prisma.patient.findUnique.mockResolvedValue(null);
    await expect(service.summary(PATIENT, {}, NOW)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });
});
