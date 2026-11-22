import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';
import {
  ProfessionalSuspensionService,
  SUSPENSION_APPOINTMENT_REASON,
} from '../src/admin/professional-suspension.service';
import type { PatientNoticesService } from '../src/notifications/patient-notices.service';
import type { ProfessionalAccountNoticesService } from '../src/notifications/professional-account-notices.service';
import type { AppointmentPaymentService } from '../src/payments/appointment-payment.service';
import type { CancellationRefundService } from '../src/payments/cancellation-refund.service';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * La suspensión de un profesional (ENG-241) contra Postgres de verdad: el
 * `UPDATE … RETURNING` que decide qué turnos se resuelven, que los que no
 * corresponden queden como estaban, la auditoría y que dos suspensiones a la
 * vez den una sola.
 */
describe('Suspensión de un profesional (integration)', () => {
  const prisma = new PrismaClient();
  const refundInFull = jest
    .fn()
    .mockResolvedValue({ percent: 100, amount: 10000, status: 'PROCESADO' });
  const expireCheckout = jest.fn().mockResolvedValue(undefined);
  const fullRefund = jest.fn().mockResolvedValue(undefined);
  const professionalCancelled = jest.fn().mockResolvedValue(undefined);
  const suspended = jest.fn().mockResolvedValue(undefined);
  const reactivated = jest.fn().mockResolvedValue(undefined);
  const service = new ProfessionalSuspensionService(
    prisma as unknown as PrismaService,
    { refundInFull } as unknown as CancellationRefundService,
    { expireCheckout } as unknown as AppointmentPaymentService,
    { fullRefund, professionalCancelled } as unknown as PatientNoticesService,
    { suspended, reactivated } as unknown as ProfessionalAccountNoticesService,
  );

  const NOW = new Date();
  const enHoras = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
  const adminId: string = randomUUID();
  const proId: string = randomUUID();
  const patientId: string = randomUUID();
  const turnos: Record<string, string> = {};

  async function turno(
    clave: string,
    status:
      | 'CONFIRMADO'
      | 'RESERVADO_SIN_PAGAR'
      | 'A_REPROGRAMAR'
      | 'COMPLETADO',
    scheduledAt: Date,
  ) {
    const a = await prisma.appointment.create({
      data: {
        patient_id: patientId,
        professional_id: proId,
        scheduled_at: scheduledAt,
        duration_minutes: 30,
        price: 10000,
        status,
        ...(status === 'A_REPROGRAMAR'
          ? {
              cancelled_by: 'PROFESIONAL' as const,
              cancellation_reason: 'Tuve un imprevisto ese día.',
              cancelled_at: enHoras(-5),
              reprogram_deadline: enHoras(20),
            }
          : {}),
      },
    });
    turnos[clave] = a.id;
  }

  beforeAll(async () => {
    await prisma.profile.createMany({
      data: [
        {
          id: adminId,
          email: `admin-${adminId}@test.local`,
          role: 'ADMINISTRADOR',
        },
        { id: proId, email: `pro-${proId}@test.local`, role: 'PROFESIONAL' },
        { id: patientId, email: `p-${patientId}@test.local`, role: 'PACIENTE' },
      ],
    });
    await prisma.patient.create({
      data: {
        profile_id: patientId,
        first_name: 'Test',
        last_name: 'Paciente',
      },
    });
    await prisma.professional.create({
      data: {
        profile_id: proId,
        first_name: 'Test',
        last_name: 'Suspendible',
        license_number: `MP-${proId.slice(0, 8)}`,
        status: 'VALIDADO',
      },
    });
    await turno('confirmadoFuturo', 'CONFIRMADO', enHoras(48));
    await turno('impagoFuturo', 'RESERVADO_SIN_PAGAR', enHoras(72));
    await turno('aReprogramar', 'A_REPROGRAMAR', enHoras(-2));
    // Lo que no se toca: una consulta que ya empezó y una pasada.
    await turno('enCurso', 'CONFIRMADO', new Date(NOW.getTime() - 10 * 60_000));
    await turno('completado', 'COMPLETADO', enHoras(-30));
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actor_id: adminId } });
    await prisma.appointment.deleteMany({ where: { professional_id: proId } });
    await prisma.patient.deleteMany({ where: { profile_id: patientId } });
    await prisma.professional.deleteMany({ where: { profile_id: proId } });
    await prisma.profile.deleteMany({
      where: { id: { in: [adminId, proId, patientId] } },
    });
    await prisma.$disconnect();
  });

  it('la vista previa cuenta los pagados y los impagos que se resolverían', async () => {
    await expect(service.preview(proId, NOW)).resolves.toEqual({
      paid: 2,
      unpaid: 1,
    });
  });

  it('suspender resuelve solo los turnos pendientes, y dos a la vez dan uno solo', async () => {
    const resultados = await Promise.allSettled([
      service.suspend(
        adminId,
        proId,
        'Denuncia verificada de un paciente.',
        NOW,
      ),
      service.suspend(
        adminId,
        proId,
        'Denuncia verificada de un paciente.',
        NOW,
      ),
    ]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult)
        .reason,
    ).toBeInstanceOf(ConflictException);

    const pro = await prisma.professional.findUniqueOrThrow({
      where: { profile_id: proId },
      select: { status: true },
    });
    expect(pro.status).toBe('SUSPENDIDO');

    const estado = async (clave: string) =>
      prisma.appointment.findUniqueOrThrow({
        where: { id: turnos[clave] },
        select: {
          status: true,
          cancelled_by: true,
          cancellation_reason: true,
          reprogram_deadline: true,
        },
      });

    expect(await estado('confirmadoFuturo')).toEqual({
      status: 'CANCELADO',
      cancelled_by: 'PROFESIONAL',
      cancellation_reason: SUSPENSION_APPOINTMENT_REASON,
      reprogram_deadline: null,
    });
    expect((await estado('impagoFuturo')).status).toBe('CANCELADO');
    // El que esperaba que el paciente eligiera conserva el motivo original.
    expect(await estado('aReprogramar')).toMatchObject({
      status: 'CANCELADO',
      cancellation_reason: 'Tuve un imprevisto ese día.',
      reprogram_deadline: null,
    });
    expect((await estado('enCurso')).status).toBe('CONFIRMADO');
    expect((await estado('completado')).status).toBe('COMPLETADO');

    // Reembolso y aviso solo de los pagados; el impago, link vencido y aviso.
    expect(refundInFull.mock.calls.map((c) => c[0] as string).sort()).toEqual(
      [turnos.confirmadoFuturo, turnos.aReprogramar].sort(),
    );
    expect(fullRefund).toHaveBeenCalledTimes(2);
    expect(fullRefund.mock.calls[0][1]).toMatchObject({ cause: 'SUSPENDIDO' });
    expect(expireCheckout).toHaveBeenCalledWith(turnos.impagoFuturo, NOW);
    expect(professionalCancelled).toHaveBeenCalledWith(
      turnos.impagoFuturo,
      'CANCELADO',
      NOW,
    );
    expect(suspended).toHaveBeenCalledTimes(1);

    const auditoria = await prisma.auditLog.findMany({
      where: { actor_id: adminId },
      select: { action: true, metadata: true },
    });
    expect(
      auditoria.filter(
        (a) => a.action === 'APPOINTMENT_CANCELLED_BY_SUSPENSION',
      ),
    ).toHaveLength(3);
    const suspension = auditoria.filter(
      (a) => a.action === 'PROFESSIONAL_SUSPENDED',
    );
    expect(suspension).toHaveLength(1);
    expect(suspension[0].metadata).toMatchObject({
      origin: 'ADMINISTRADOR',
      refunded: 2,
      cancelled: 1,
    });
  });

  it('reactivar lo vuelve a validar, sin revivir los turnos resueltos', async () => {
    await service.reactivate(
      adminId,
      proId,
      'La denuncia se resolvió a favor.',
      NOW,
    );

    const pro = await prisma.professional.findUniqueOrThrow({
      where: { profile_id: proId },
      select: { status: true },
    });
    expect(pro.status).toBe('VALIDADO');
    const cancelados = await prisma.appointment.count({
      where: { professional_id: proId, status: 'CANCELADO' },
    });
    expect(cancelados).toBe(3);
    await expect(
      service.reactivate(adminId, proId, 'Otra vez por las dudas.', NOW),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
