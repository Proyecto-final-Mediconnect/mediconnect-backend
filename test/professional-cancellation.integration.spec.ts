import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';
import { ProfessionalCancellationService } from '../src/appointments/professional-cancellation.service';
import type { PatientNoticesService } from '../src/notifications/patient-notices.service';
import type { AppointmentPaymentService } from '../src/payments/appointment-payment.service';
import { CancellationRefundService } from '../src/payments/cancellation-refund.service';
import type { MercadoPagoService } from '../src/payments/mercadopago.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SupabaseService } from '../src/supabase/supabase.service';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

/**
 * ENG-204 (ADR-018) contra Postgres real.
 *
 * Lo que un mock no puede probar:
 * - el CHECK que obliga a un turno `A_REPROGRAMAR` a tener plazo y a haberlo
 *   cancelado el profesional;
 * - que `A_REPROGRAMAR` **libera el horario** (el índice parcial de horarios
 *   ocupados de ENG-54 no lo cuenta);
 * - que, cuando el paciente pide el reembolso justo cuando vence el plazo, se
 *   devuelve **una sola vez**.
 *
 * `db push` no crea lo que Prisma no modela (CHECK e índices parciales), así que
 * el spec carga esas sentencias de las migraciones.
 */
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

async function applyStatements(
  prisma: PrismaClient,
  folder: string,
  match: RegExp,
): Promise<number> {
  const statements = readFileSync(
    join(MIGRATIONS, folder, 'migration.sql'),
    'utf8',
  )
    .split(/^--;;[ \t]*\r?$/m)
    .map((s) => s.replace(/^--.*$/gm, '').trim())
    .filter((s) => match.test(s));
  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (error) {
      // Una corrida anterior contra la misma base ya las creó.
      if (!/already exists/.test(String(error))) throw error;
    }
  }
  return statements.length;
}

describe('El profesional cancela un turno (integration, ENG-204)', () => {
  const prisma = new PrismaClient();
  const patientId = randomUUID();
  const professionalId = randomUUID();
  const refundPayment = jest.fn();
  let service: ProfessionalCancellationService;
  /** El turno que "lee" Supabase: el service lo pide con el JWT del usuario. */
  let visible: Record<string, unknown> | null;

  async function appointment(
    status: string,
    scheduledAt: Date,
    paid = true,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.appointment.create({
      data: {
        id,
        patient_id: patientId,
        professional_id: professionalId,
        scheduled_at: scheduledAt,
        duration_minutes: 30,
        price: 18000,
        status: status as never,
      },
    });
    if (paid) {
      await prisma.payment.create({
        data: {
          appointment_id: id,
          amount: 18000,
          status: 'APROBADO',
          mercadopago_payment_id: `mp-${id.slice(0, 8)}`,
        },
      });
    }
    return id;
  }

  async function show(id: string) {
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id } });
    visible = {
      id: a.id,
      patient_id: a.patient_id,
      professional_id: a.professional_id,
      scheduled_at: a.scheduled_at.toISOString(),
      status: a.status,
    };
  }

  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    // La migración de ENG-54 no está partida en `--;;`: se toma el índice solo.
    const eng54 = readFileSync(
      join(
        MIGRATIONS,
        '20260815000000_eng54_appointments_booking',
        'migration.sql',
      ),
      'utf8',
    ).match(
      /create unique index if not exists appointments_professional_active_slot_key[\s\S]*?;/,
    );
    expect(eng54).not.toBeNull();
    await prisma.$executeRawUnsafe(eng54![0]);
    expect(
      await applyStatements(
        prisma,
        '20261121130100_eng204_professional_cancellation',
        /^(ALTER TABLE "appointments" ADD CONSTRAINT|CREATE (UNIQUE )?INDEX)/,
      ),
    ).toBe(3);

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

    const supabase = {
      getClientForToken: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: visible, error: null }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseService;
    const refunds = new CancellationRefundService(
      prisma as unknown as PrismaService,
      { refundPayment } as unknown as MercadoPagoService,
    );
    service = new ProfessionalCancellationService(
      prisma as unknown as PrismaService,
      supabase,
      { expireCheckout: jest.fn() } as unknown as AppointmentPaymentService,
      refunds,
      {
        professionalCancelled: jest.fn(),
        fullRefund: jest.fn(),
      } as unknown as PatientNoticesService,
    );
  });

  beforeEach(() => {
    refundPayment.mockReset().mockImplementation(async () => {
      // Como MercadoPago: tarda un poco. Abre la ventana de la carrera.
      await new Promise((r) => setTimeout(r, 50));
      return { id: `mp-ref-${randomUUID().slice(0, 8)}`, status: 'approved' };
    });
  });

  afterAll(async () => {
    const ids = (
      await prisma.appointment.findMany({
        where: { patient_id: patientId },
        select: { id: true },
      })
    ).map((a) => a.id);
    await prisma.refund.deleteMany({
      where: { payment: { appointment_id: { in: ids } } },
    });
    await prisma.payment.deleteMany({ where: { appointment_id: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { resource_id: { in: ids } } });
    await prisma.appointment.deleteMany({ where: { id: { in: ids } } });
    await prisma.professional.deleteMany({
      where: { profile_id: professionalId },
    });
    await prisma.patient.deleteMany({ where: { profile_id: patientId } });
    await prisma.profile.deleteMany({
      where: { id: { in: [patientId, professionalId] } },
    });
    await prisma.$disconnect();
  });

  it('la base no acepta un A_REPROGRAMAR sin plazo o que no canceló el profesional', async () => {
    const id = await appointment('CONFIRMADO', inHours(72), false);

    await expect(
      prisma.appointment.update({
        where: { id },
        data: { status: 'A_REPROGRAMAR', cancelled_by: 'PROFESIONAL' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.appointment.update({
        where: { id },
        data: {
          status: 'A_REPROGRAMAR',
          cancelled_by: 'PACIENTE',
          reprogram_deadline: inHours(48),
        },
      }),
    ).rejects.toThrow();
  });

  it('cancelar un turno pagado lo deja A_REPROGRAMAR y libera el horario', async () => {
    const when = inHours(96);
    const id = await appointment('CONFIRMADO', when);
    await show(id);

    const result = await service.cancelByProfessional(
      'jwt',
      professionalId,
      id,
      'Tengo un congreso ese día.',
    );

    expect(result.status).toBe('A_REPROGRAMAR');
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      status: 'A_REPROGRAMAR',
      cancelled_by: 'PROFESIONAL',
      cancellation_reason: 'Tengo un congreso ese día.',
    });
    expect(row.reprogram_deadline).not.toBeNull();

    // Otro paciente puede tomar ese mismo horario: el índice parcial ya no lo cuenta.
    await expect(appointment('CONFIRMADO', when, false)).resolves.toBeDefined();
    expect(
      await prisma.auditLog.count({
        where: {
          resource_id: id,
          action: 'APPOINTMENT_CANCELLED_BY_PROFESSIONAL',
        },
      }),
    ).toBe(1);
  });

  it('el paciente pide el reembolso y el plazo vence a la vez: se devuelve una sola vez', async () => {
    const id = await appointment('CONFIRMADO', inHours(120));
    await prisma.appointment.update({
      where: { id },
      data: {
        status: 'A_REPROGRAMAR',
        cancelled_by: 'PROFESIONAL',
        cancelled_at: new Date(),
        // Ya vencido: el job también lo quiere resolver.
        reprogram_deadline: inHours(-1),
      },
    });
    await show(id);

    const [byPatient, byJob] = await Promise.allSettled([
      service.requestFullRefund('jwt', patientId, id),
      service.resolveReprogramDeadlines(),
    ]);

    const refunds = await prisma.refund.findMany({
      where: { payment: { appointment_id: id } },
    });
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount.toNumber()).toBe(18000);
    expect(refundPayment).toHaveBeenCalledTimes(1);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('CANCELADO');
    // Ganó exactamente uno de los dos caminos.
    const patientWon = byPatient.status === 'fulfilled';
    const jobWon = byJob.status === 'fulfilled' && byJob.value.expired === 1;
    expect(patientWon !== jobWon).toBe(true);
    expect(row.cancelled_by).toBe(patientWon ? 'PROFESIONAL' : 'SISTEMA');
    expect(refunds[0].reason).toBe(
      patientWon ? 'CANCELACION_PROFESIONAL' : 'VENCIMIENTO_REPROGRAMACION',
    );
  });

  it('el job retoma un reembolso total que quedó sin registrar', async () => {
    const id = await appointment('CONFIRMADO', inHours(144));
    await prisma.appointment.update({
      where: { id },
      data: {
        status: 'CANCELADO',
        cancelled_by: 'SISTEMA',
        // Hace rato: no es un request en curso.
        updated_at: new Date(Date.now() - 60 * 60_000),
      },
    });

    const summary = await service.resolveReprogramDeadlines();

    expect(summary.recovered).toBeGreaterThanOrEqual(1);
    const refunds = await prisma.refund.findMany({
      where: { payment: { appointment_id: id } },
    });
    expect(refunds).toHaveLength(1);
    expect(refunds[0].reason).toBe('VENCIMIENTO_REPROGRAMACION');
    // Y no lo vuelve a tomar.
    refundPayment.mockClear();
    await service.resolveReprogramDeadlines();
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it('dos reembolsos totales del mismo pago a la vez: la base deja uno solo', async () => {
    const id = await appointment('CONFIRMADO', inHours(168));
    const refunds = new CancellationRefundService(
      prisma as unknown as PrismaService,
      { refundPayment } as unknown as MercadoPagoService,
    );

    await Promise.all([
      refunds.refundInFull(id, new Date(), 'CANCELACION_PROFESIONAL'),
      refunds.refundInFull(id, new Date(), 'VENCIMIENTO_REPROGRAMACION'),
    ]);

    expect(
      await prisma.refund.count({ where: { payment: { appointment_id: id } } }),
    ).toBe(1);
    expect(refundPayment).toHaveBeenCalledTimes(1);
  });
});
