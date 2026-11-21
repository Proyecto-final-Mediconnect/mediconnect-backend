import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, Logger } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';
import { ProfessionalCancellationService } from '../src/appointments/professional-cancellation.service';
import type { InAppNotificationsService } from '../src/notifications/in-app-notifications.service';
import type { PatientNoticesService } from '../src/notifications/patient-notices.service';
import type { AppointmentPaymentService } from '../src/payments/appointment-payment.service';
import type { CancellationRefundService } from '../src/payments/cancellation-refund.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { SchedulesService } from '../src/schedules/schedules.service';
import type { SupabaseService } from '../src/supabase/supabase.service';

/**
 * ENG-206 contra Postgres real: un bloqueo que pisa turnos los cancela **en la
 * misma transacción** que crea el bloqueo. O queda todo, o nada.
 */
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

describe('Bloqueo con turnos tomados (integration, ENG-206)', () => {
  const prisma = new PrismaClient();
  const patientId = randomUUID();
  const professionalId = randomUUID();
  const notices = { professionalCancelled: jest.fn(), fullRefund: jest.fn() };
  let schedules: SchedulesService;
  const NOW = new Date();
  /** Un día dentro de dos semanas, en hora de Argentina. */
  const DAY = new Date(NOW.getTime() + 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00-03:00`);

  async function appointment(status: string, hhmm: string): Promise<string> {
    const id = randomUUID();
    await prisma.appointment.create({
      data: {
        id,
        patient_id: patientId,
        professional_id: professionalId,
        scheduled_at: at(hhmm),
        duration_minutes: 30,
        price: 18000,
        status: status as never,
      },
    });
    return id;
  }

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // El CHECK de `A_REPROGRAMAR` (ENG-204) y el índice parcial de horarios.
    const sql = readFileSync(
      join(
        MIGRATIONS,
        '20261121130100_eng204_professional_cancellation',
        'migration.sql',
      ),
      'utf8',
    )
      .split(/^--;;[ \t]*\r?$/m)
      .map((s) => s.replace(/^--.*$/gm, '').trim())
      .filter((s) => /^ALTER TABLE "appointments" ADD CONSTRAINT/.test(s));
    for (const statement of sql) {
      await prisma.$executeRawUnsafe(statement).catch((e: unknown) => {
        if (!/already exists/.test(String(e))) throw e;
      });
    }

    await prisma.profile.createMany({
      data: [
        { id: patientId, email: `p-${patientId}@test.local`, role: 'PACIENTE' },
        {
          id: professionalId,
          email: `pro-${professionalId}@test.local`,
          role: 'PROFESIONAL',
        },
      ],
    });
    await prisma.patient.create({
      data: {
        profile_id: patientId,
        first_name: 'Julián',
        last_name: 'Paciente',
      },
    });
    await prisma.professional.create({
      data: {
        profile_id: professionalId,
        first_name: 'Ana',
        last_name: 'Profesional',
        license_number: `MP-${professionalId.slice(0, 8)}`,
      },
    });

    // Solo para `assertProfileExists`: el perfil profesional existe.
    const supabase = {
      getClientForToken: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { profile_id: professionalId },
                  error: null,
                }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseService;
    const cancellation = new ProfessionalCancellationService(
      prisma as unknown as PrismaService,
      supabase,
      { expireCheckout: jest.fn() } as unknown as AppointmentPaymentService,
      { refundInFull: jest.fn() } as unknown as CancellationRefundService,
      notices as unknown as PatientNoticesService,
      { notifyProfessional: jest.fn() } as unknown as InAppNotificationsService,
    );
    schedules = new SchedulesService(
      supabase,
      prisma as unknown as PrismaService,
      cancellation,
    );
  });

  afterAll(async () => {
    const ids = (
      await prisma.appointment.findMany({
        where: { professional_id: professionalId },
        select: { id: true },
      })
    ).map((a) => a.id);
    await prisma.auditLog.deleteMany({ where: { resource_id: { in: ids } } });
    await prisma.appointment.deleteMany({ where: { id: { in: ids } } });
    await prisma.scheduleBlock.deleteMany({
      where: { professional_id: professionalId },
    });
    await prisma.professional.deleteMany({
      where: { profile_id: professionalId },
    });
    await prisma.patient.deleteMany({ where: { profile_id: patientId } });
    await prisma.profile.deleteMany({
      where: { id: { in: [patientId, professionalId] } },
    });
    await prisma.$disconnect();
  });

  it('cancela los turnos que pisa y deja el bloqueo, todo junto', async () => {
    const pagado = await appointment('CONFIRMADO', '10:00');
    const sinPagar = await appointment('RESERVADO_SIN_PAGAR', '10:30');
    const afuera = await appointment('CONFIRMADO', '16:00');

    const block = await schedules.createBlock(
      'jwt',
      professionalId,
      {
        blockDate: DAY,
        startTime: '09:00',
        endTime: '12:00',
        cancelAffected: true,
        cancellationReason: 'Tengo un congreso esa mañana.',
      },
      NOW,
    );

    expect(block.cancelledAppointments.map((c) => c.status).sort()).toEqual([
      'A_REPROGRAMAR',
      'CANCELADO',
    ]);
    const rows = await prisma.appointment.findMany({
      where: { id: { in: [pagado, sinPagar, afuera] } },
      select: {
        id: true,
        status: true,
        cancelled_by: true,
        cancellation_reason: true,
      },
    });
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[pagado]).toMatchObject({
      status: 'A_REPROGRAMAR',
      cancelled_by: 'PROFESIONAL',
      cancellation_reason: 'Tengo un congreso esa mañana.',
    });
    expect(by[sinPagar].status).toBe('CANCELADO');
    // El de la tarde no se toca.
    expect(by[afuera].status).toBe('CONFIRMADO');
    expect(
      await prisma.scheduleBlock.count({
        where: { professional_id: professionalId },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { resource_id: { in: [pagado, sinPagar] } },
      }),
    ).toBe(2);
    expect(notices.professionalCancelled).toHaveBeenCalledTimes(2);
  });

  it('si un turno no se puede cancelar, no queda ni el bloqueo ni ninguna cancelación', async () => {
    const OTRO_DIA = new Date(NOW.getTime() + 21 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const id = randomUUID();
    await prisma.appointment.create({
      data: {
        id,
        patient_id: patientId,
        professional_id: professionalId,
        scheduled_at: new Date(`${OTRO_DIA}T10:00:00-03:00`),
        duration_minutes: 30,
        price: 18000,
        status: 'CONFIRMADO',
      },
    });
    // Otro turno que alguien liberó justo después de la lectura: el UPDATE
    // condicional no lo encuentra y toda la transacción vuelve atrás.
    const id2 = randomUUID();
    await prisma.appointment.create({
      data: {
        id: id2,
        patient_id: patientId,
        professional_id: professionalId,
        scheduled_at: new Date(`${OTRO_DIA}T11:00:00-03:00`),
        duration_minutes: 30,
        price: 18000,
        status: 'RESERVADO_SIN_PAGAR',
      },
    });
    const original = prisma.$transaction.bind(prisma);
    const spy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(async (cb: unknown, opts?: unknown) => {
        await prisma.appointment.update({
          where: { id: id2 },
          data: { status: 'LIBERADO' },
        });
        return original(cb as never, opts as never);
      });

    await expect(
      schedules.createBlock(
        'jwt',
        professionalId,
        {
          blockDate: OTRO_DIA,
          cancelAffected: true,
          cancellationReason: 'Tengo un congreso ese día.',
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    spy.mockRestore();

    expect(
      await prisma.appointment.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      }),
    ).toEqual({ status: 'CONFIRMADO' });
    expect(
      await prisma.scheduleBlock.count({
        where: {
          professional_id: professionalId,
          block_date: new Date(`${OTRO_DIA}T00:00:00.000Z`),
        },
      }),
    ).toBe(0);
  });
});
