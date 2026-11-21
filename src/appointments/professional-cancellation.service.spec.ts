import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import type { PatientNoticesService } from '../notifications/patient-notices.service';
import type { AppointmentPaymentService } from '../payments/appointment-payment.service';
import type { CancellationRefundService } from '../payments/cancellation-refund.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SupabaseService } from '../supabase/supabase.service';
import {
  ProfessionalCancellationService,
  REFUND_SWEEP_GRACE_MINUTES,
  REPROGRAM_WINDOW_HOURS,
  reprogramDeadlineFor,
} from './professional-cancellation.service';

const APPOINTMENT = '44444444-4444-4444-8444-444444444444';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const REASON = 'Tengo un congreso ese día y no voy a estar.';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT,
    patient_id: PATIENT,
    professional_id: PROFESSIONAL,
    scheduled_at: hours(72).toISOString(),
    status: 'CONFIRMADO',
    ...overrides,
  };
}

function prismaError(code: string) {
  return Object.assign(new Error(code), { code });
}

describe('reprogramDeadlineFor', () => {
  it(`da ${REPROGRAM_WINDOW_HOURS} h desde el aviso si el turno es más tarde`, () => {
    expect(reprogramDeadlineFor(hours(72), NOW)).toEqual(
      hours(REPROGRAM_WINDOW_HOURS),
    );
  });

  it('da la hora del turno si llega antes que las 48 h', () => {
    expect(reprogramDeadlineFor(hours(5), NOW)).toEqual(hours(5));
  });
});

describe('ProfessionalCancellationService', () => {
  let service: ProfessionalCancellationService;
  let tx: {
    appointment: { update: jest.Mock };
    auditLog: { create: jest.Mock; createMany: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let prisma: {
    $transaction: jest.Mock;
    appointment: { findMany: jest.Mock };
  };
  let expireCheckout: jest.Mock;
  let refundInFull: jest.Mock;
  let notices: {
    professionalCancelled: jest.Mock;
    fullRefund: jest.Mock;
    reprogramDeadlineSoon: jest.Mock;
  };
  let inApp: { notifyProfessional: jest.Mock };

  function build(data: unknown, error: unknown = null) {
    const maybeSingle = jest.fn().mockResolvedValue({ data, error });
    const supabase = {
      getClientForToken: () => ({
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
      }),
    } as unknown as SupabaseService;

    tx = {
      appointment: { update: jest.fn().mockResolvedValue({}) },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    prisma = {
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    expireCheckout = jest.fn().mockResolvedValue(undefined);
    refundInFull = jest
      .fn()
      .mockResolvedValue({ percent: 100, amount: 18000, status: 'PROCESADO' });
    notices = {
      professionalCancelled: jest.fn().mockResolvedValue(undefined),
      fullRefund: jest.fn().mockResolvedValue(undefined),
      reprogramDeadlineSoon: jest.fn().mockResolvedValue(undefined),
    };
    inApp = { notifyProfessional: jest.fn().mockResolvedValue(undefined) };

    service = new ProfessionalCancellationService(
      prisma as unknown as PrismaService,
      supabase,
      { expireCheckout } as unknown as AppointmentPaymentService,
      { refundInFull } as unknown as CancellationRefundService,
      notices as unknown as PatientNoticesService,
      inApp as unknown as InAppNotificationsService,
    );
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    build(row());
  });

  describe('cancelByProfessional', () => {
    it('un turno pagado pasa a A_REPROGRAMAR con plazo, motivo y auditoría', async () => {
      const result = await service.cancelByProfessional(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        REASON,
        NOW,
      );

      const deadline = hours(REPROGRAM_WINDOW_HOURS);
      expect(result).toEqual({
        id: APPOINTMENT,
        status: 'A_REPROGRAMAR',
        cancelledBy: 'PROFESIONAL',
        reprogramDeadline: deadline.toISOString(),
      });
      expect(tx.appointment.update).toHaveBeenCalledWith({
        where: {
          id: APPOINTMENT,
          professional_id: PROFESSIONAL,
          status: 'CONFIRMADO',
          scheduled_at: { gt: NOW },
        },
        data: {
          status: 'A_REPROGRAMAR',
          cancelled_by: 'PROFESIONAL',
          cancellation_reason: REASON,
          cancelled_at: NOW,
          reprogram_deadline: deadline,
          updated_at: NOW,
        },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: PROFESSIONAL,
          action: 'APPOINTMENT_CANCELLED_BY_PROFESSIONAL',
          resource_id: APPOINTMENT,
          metadata: expect.objectContaining({
            previousStatus: 'CONFIRMADO',
            newStatus: 'A_REPROGRAMAR',
            reason: REASON,
          }),
        }),
      });
      expect(notices.professionalCancelled).toHaveBeenCalledWith(
        APPOINTMENT,
        'A_REPROGRAMAR',
        NOW,
      );
      // Un turno pagado no tiene link de pago que vencer ni reembolso inmediato:
      // el paciente todavía tiene que elegir.
      expect(expireCheckout).not.toHaveBeenCalled();
      expect(refundInFull).not.toHaveBeenCalled();
    });

    it('si el turno es antes de 48 h, el plazo es la hora del turno', async () => {
      build(row({ scheduled_at: hours(3).toISOString() }));

      const result = await service.cancelByProfessional(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        REASON,
        NOW,
      );

      expect(result.reprogramDeadline).toBe(hours(3).toISOString());
    });

    it('una reserva sin pagar queda CANCELADO, sin plazo, y se vence el link de pago', async () => {
      build(row({ status: 'RESERVADO_SIN_PAGAR' }));

      const result = await service.cancelByProfessional(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        REASON,
        NOW,
      );

      expect(result).toMatchObject({
        status: 'CANCELADO',
        reprogramDeadline: null,
      });
      expect(tx.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'RESERVADO_SIN_PAGAR' }),
          data: expect.objectContaining({
            status: 'CANCELADO',
            cancelled_by: 'PROFESIONAL',
            reprogram_deadline: null,
          }),
        }),
      );
      expect(expireCheckout).toHaveBeenCalledWith(APPOINTMENT, NOW);
      expect(notices.professionalCancelled).toHaveBeenCalledWith(
        APPOINTMENT,
        'CANCELADO',
        NOW,
      );
    });

    it('404 si el turno no se ve (RLS)', async () => {
      build(null);
      await expect(
        service.cancelByProfessional(
          'jwt',
          PROFESSIONAL,
          APPOINTMENT,
          REASON,
          NOW,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('500 si la lectura falla', async () => {
      build(null, { message: 'boom' });
      await expect(
        service.cancelByProfessional(
          'jwt',
          PROFESSIONAL,
          APPOINTMENT,
          REASON,
          NOW,
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it.each([
      ['el paciente', PATIENT],
      ['otro profesional', OTHER],
    ])('403 si lo intenta %s', async (_quien, userId) => {
      await expect(
        service.cancelByProfessional('jwt', userId, APPOINTMENT, REASON, NOW),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.appointment.update).not.toHaveBeenCalled();
    });

    it('409 si el turno ya empezó (eso es ENG-237)', async () => {
      build(row({ scheduled_at: NOW.toISOString() }));
      await expect(
        service.cancelByProfessional(
          'jwt',
          PROFESSIONAL,
          APPOINTMENT,
          REASON,
          NOW,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([
      'CANCELADO',
      'LIBERADO',
      'COMPLETADO',
      'NO_ASISTIO',
      'A_REPROGRAMAR',
    ])('409 si el turno está %s', async (status) => {
      build(row({ status }));
      await expect(
        service.cancelByProfessional(
          'jwt',
          PROFESSIONAL,
          APPOINTMENT,
          REASON,
          NOW,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.appointment.update).not.toHaveBeenCalled();
    });

    it('409 si el turno cambió entre la lectura y la escritura, sin avisar', async () => {
      tx.appointment.update.mockRejectedValue(prismaError('P2025'));
      await expect(
        service.cancelByProfessional(
          'jwt',
          PROFESSIONAL,
          APPOINTMENT,
          REASON,
          NOW,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(notices.professionalCancelled).not.toHaveBeenCalled();
    });

    it('500 si la escritura falla por otra cosa', async () => {
      tx.appointment.update.mockRejectedValue(new Error('timeout'));
      await expect(
        service.cancelByProfessional(
          'jwt',
          PROFESSIONAL,
          APPOINTMENT,
          REASON,
          NOW,
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('requestFullRefund', () => {
    beforeEach(() => build(row({ status: 'A_REPROGRAMAR' })));

    it('cancela el turno, devuelve el 100 % y avisa', async () => {
      const result = await service.requestFullRefund(
        'jwt',
        PATIENT,
        APPOINTMENT,
        NOW,
      );

      expect(result).toEqual({
        id: APPOINTMENT,
        status: 'CANCELADO',
        refund: { percent: 100, amount: 18000, status: 'PROCESADO' },
      });
      expect(tx.appointment.update).toHaveBeenCalledWith({
        where: {
          id: APPOINTMENT,
          patient_id: PATIENT,
          status: 'A_REPROGRAMAR',
        },
        data: { status: 'CANCELADO', updated_at: NOW },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: PATIENT,
          action: 'APPOINTMENT_FULL_REFUND_CHOSEN',
        }),
      });
      expect(refundInFull).toHaveBeenCalledWith(
        APPOINTMENT,
        NOW,
        'CANCELACION_PROFESIONAL',
      );
      expect(notices.fullRefund).toHaveBeenCalledWith(
        APPOINTMENT,
        { amount: 18000, status: 'PROCESADO', cause: 'ELEGIDO' },
        NOW,
      );
    });

    it('403 si no es el paciente del turno', async () => {
      await expect(
        service.requestFullRefund('jwt', PROFESSIONAL, APPOINTMENT, NOW),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(refundInFull).not.toHaveBeenCalled();
    });

    it.each(['CONFIRMADO', 'CANCELADO', 'RESERVADO_SIN_PAGAR'])(
      '409 si el turno está %s',
      async (status) => {
        build(row({ status }));
        await expect(
          service.requestFullRefund('jwt', PATIENT, APPOINTMENT, NOW),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(refundInFull).not.toHaveBeenCalled();
      },
    );

    it('le avisa al profesional que el paciente eligió el reembolso (ENG-208)', async () => {
      await service.requestFullRefund('jwt', PATIENT, APPOINTMENT, NOW);

      expect(inApp.notifyProfessional).toHaveBeenCalledWith(
        APPOINTMENT,
        'TURNO_REEMBOLSADO',
        NOW,
        { cause: 'ELEGIDO' },
      );
    });

    it('409 y sin reembolso si el job lo resolvió en el medio', async () => {
      tx.appointment.update.mockRejectedValue(prismaError('P2025'));
      await expect(
        service.requestFullRefund('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(refundInFull).not.toHaveBeenCalled();
      expect(notices.fullRefund).not.toHaveBeenCalled();
    });
  });

  describe('resolveReprogramDeadlines', () => {
    it('vence los turnos, los audita, reembolsa el 100 % y avisa', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);

      const summary = await service.resolveReprogramDeadlines(NOW);

      expect(summary).toEqual({ reminded: 0, expired: 2, recovered: 0 });
      expect(tx.auditLog.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            actor_id: null,
            action: 'APPOINTMENT_REPROGRAM_EXPIRED',
            resource_id: 'a1',
          }),
          expect.objectContaining({ resource_id: 'a2' }),
        ],
      });
      expect(inApp.notifyProfessional).toHaveBeenCalledWith(
        'a1',
        'TURNO_REEMBOLSADO',
        NOW,
        { cause: 'VENCIDO' },
      );
      expect(refundInFull).toHaveBeenCalledWith(
        'a1',
        NOW,
        'VENCIMIENTO_REPROGRAMACION',
      );
      expect(refundInFull).toHaveBeenCalledWith(
        'a2',
        NOW,
        'VENCIMIENTO_REPROGRAMACION',
      );
      expect(notices.fullRefund).toHaveBeenCalledWith(
        'a1',
        { amount: 18000, status: 'PROCESADO', cause: 'VENCIDO' },
        NOW,
      );
    });

    it('sin vencidos no audita ni reembolsa', async () => {
      const summary = await service.resolveReprogramDeadlines(NOW);

      expect(summary).toEqual({ reminded: 0, expired: 0, recovered: 0 });
      expect(tx.auditLog.createMany).not.toHaveBeenCalled();
      expect(refundInFull).not.toHaveBeenCalled();
    });

    it('retoma los reembolsos totales que quedaron a medias, con el motivo de cada uno', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        { id: 'p1', cancelled_by: 'PROFESIONAL' },
        { id: 's1', cancelled_by: 'SISTEMA' },
      ]);

      const summary = await service.resolveReprogramDeadlines(NOW);

      expect(summary).toEqual({ reminded: 0, expired: 0, recovered: 2 });
      expect(prisma.appointment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'CANCELADO',
            cancelled_by: { in: ['PROFESIONAL', 'SISTEMA'] },
            updated_at: {
              lt: new Date(NOW.getTime() - REFUND_SWEEP_GRACE_MINUTES * 60_000),
            },
            payment: { status: 'APROBADO', refunds: { none: {} } },
          },
        }),
      );
      expect(refundInFull).toHaveBeenCalledWith(
        'p1',
        NOW,
        'CANCELACION_PROFESIONAL',
      );
      expect(refundInFull).toHaveBeenCalledWith(
        's1',
        NOW,
        'VENCIMIENTO_REPROGRAMACION',
      );
      expect(notices.fullRefund).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ cause: 'VENCIDO' }),
        NOW,
      );
    });
  });
});

describe('ProfessionalCancellationService: recordatorio del plazo (ENG-208)', () => {
  const NOW = new Date('2026-11-21T12:00:00.000Z');
  const HOUR = 3_600_000;
  let findMany: jest.Mock;
  let reprogramDeadlineSoon: jest.Mock;
  let notifyProfessional: jest.Mock;
  let service: ProfessionalCancellationService;

  /** Un turno a reprogramar cancelado hace `hace` h, con plazo en `vence` h. */
  function aReprogramar(
    id: string,
    hace: number,
    vence: number,
    avisos: { sent_at: Date | null }[] = [],
  ) {
    return {
      id,
      cancelled_at: new Date(NOW.getTime() - hace * HOUR),
      reprogram_deadline: new Date(NOW.getTime() + vence * HOUR),
      notifications: avisos,
    };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    findMany = jest.fn().mockResolvedValue([]);
    reprogramDeadlineSoon = jest.fn().mockResolvedValue(undefined);
    notifyProfessional = jest.fn().mockResolvedValue(undefined);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      auditLog: { createMany: jest.fn() },
    };
    service = new ProfessionalCancellationService(
      {
        $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
        appointment: { findMany },
      } as unknown as PrismaService,
      {} as unknown as SupabaseService,
      {} as unknown as AppointmentPaymentService,
      { refundInFull: jest.fn() } as unknown as CancellationRefundService,
      {
        reprogramDeadlineSoon,
        fullRefund: jest.fn(),
      } as unknown as PatientNoticesService,
      { notifyProfessional } as unknown as InAppNotificationsService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('le recuerda al paciente cuando quedan 12 h o menos, una vez por cancelación', async () => {
    findMany.mockResolvedValueOnce([
      // Cancelado hace 40 h, vence en 8 h: se recuerda.
      aReprogramar('a1', 40, 8),
      // Ya recordado en esta cancelación.
      aReprogramar('a2', 40, 6, [{ sent_at: new Date(NOW.getTime() - HOUR) }]),
      // Recordado en una cancelación anterior (caso 12): se recuerda de nuevo.
      aReprogramar('a3', 30, 10, [
        { sent_at: new Date(NOW.getTime() - 100 * HOUR) },
      ]),
      // Al cancelar ya quedaban 10 h: el aviso de la cancelación alcanza.
      aReprogramar('a4', 2, 8),
    ]);

    const summary = await service.resolveReprogramDeadlines(NOW);

    expect(summary.reminded).toBe(2);
    expect(
      reprogramDeadlineSoon.mock.calls.map((c: unknown[]) => c[0] as string),
    ).toEqual(['a1', 'a3']);
    expect(findMany.mock.calls[0][0].where).toEqual({
      status: 'A_REPROGRAMAR',
      reprogram_deadline: {
        gt: NOW,
        lte: new Date(NOW.getTime() + 12 * HOUR),
      },
    });
  });

  it('si el recordatorio falla, los vencimientos se resuelven igual', async () => {
    findMany.mockRejectedValueOnce(new Error('db caída'));

    await expect(service.resolveReprogramDeadlines(NOW)).resolves.toEqual({
      reminded: 0,
      expired: 0,
      recovered: 0,
    });
  });
});
