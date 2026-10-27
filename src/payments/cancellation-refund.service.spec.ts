import { Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CancellationRefundService } from './cancellation-refund.service';
import { MercadoPagoService } from './mercadopago.service';

/**
 * Reembolso al cancelar (ENG-65).
 *
 * Prisma y MercadoPago van mockeados: lo que se verifica es la regla —qué
 * política se usa, cuánto se devuelve, y qué queda escrito si MercadoPago
 * falla—. El cálculo del porcentaje en sí lo cubre `cancellation-policy.spec.ts`.
 */

const APPOINTMENT_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-22T12:00:00.000Z');

/** Turno a `hours` horas de `NOW`. */
function inHours(hours: number): Date {
  return new Date(NOW.getTime() + hours * 3_600_000);
}

function appointment(
  overrides: {
    scheduled_at?: Date;
    policy?: [number | null, number | null, number | null];
    payment?: Record<string, unknown> | null;
  } = {},
) {
  const [full, partial, percent] = overrides.policy ?? [null, null, null];
  return {
    id: APPOINTMENT_ID,
    scheduled_at: overrides.scheduled_at ?? inHours(48),
    policy_hours_full_refund: full,
    policy_hours_partial_refund: partial,
    policy_partial_refund_percent: percent,
    payment:
      overrides.payment === null
        ? null
        : {
            id: 'pay-1',
            amount: new Prisma.Decimal('15000.00'),
            status: 'APROBADO',
            mercadopago_payment_id: 'mp-123',
            ...overrides.payment,
          },
  };
}

describe('CancellationRefundService', () => {
  let service: CancellationRefundService;
  let prisma: {
    appointment: { findUnique: jest.Mock };
    refund: { create: jest.Mock; update: jest.Mock };
    payment: { update: jest.Mock };
  };
  let mercadoPago: { refundPayment: jest.Mock };
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      appointment: { findUnique: jest.fn().mockResolvedValue(appointment()) },
      refund: {
        create: jest.fn().mockResolvedValue({ id: 'ref-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      payment: { update: jest.fn().mockResolvedValue({}) },
    };
    mercadoPago = {
      refundPayment: jest
        .fn()
        .mockResolvedValue({ id: '9001', status: 'approved', amount: 15000 }),
    };
    service = new CancellationRefundService(
      prisma as unknown as PrismaService,
      mercadoPago as unknown as MercadoPagoService,
    );
    loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('refundCancellation', () => {
    it('con mucha antelación devuelve todo y marca el pago REEMBOLSADO', async () => {
      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toEqual({ percent: 100, amount: 15000, status: 'PROCESADO' });

      expect(mercadoPago.refundPayment).toHaveBeenCalledWith(
        'mp-123',
        15000,
        'refund-ref-1',
      );
      expect(prisma.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref-1' },
        data: {
          status: 'PROCESADO',
          mercadopago_refund_id: '9001',
          processed_at: NOW,
        },
      });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-1' },
        data: { status: 'REEMBOLSADO' },
      });
    });

    it('en la ventana parcial devuelve el porcentaje y el pago sigue APROBADO', async () => {
      // Default: 24 h → 100 %, 6 h → 50 %.
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ scheduled_at: inHours(10) }),
      );

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toEqual({ percent: 50, amount: 7500, status: 'PROCESADO' });
      expect(mercadoPago.refundPayment).toHaveBeenCalledWith(
        'mp-123',
        7500,
        'refund-ref-1',
      );
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('usa la política congelada en el turno, no el default', async () => {
      // El profesional tenía 72 h → 100 %, 48 h → 20 % cuando se reservó.
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ scheduled_at: inHours(50), policy: [72, 48, 20] }),
      );

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toMatchObject({ percent: 20, amount: 3000 });
    });

    it('con poca antelación no devuelve nada ni llama a MercadoPago', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ scheduled_at: inHours(2) }),
      );

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toEqual({ percent: 0, amount: 0, status: null });
      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
    });

    it('sin pago aprobado no hay nada que devolver', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ payment: { status: 'PENDIENTE' } }),
      );

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toMatchObject({ amount: 0, status: null });
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
    });

    it('si MercadoPago falla, el reembolso queda PENDIENTE y no tira', async () => {
      mercadoPago.refundPayment.mockRejectedValue(new Error('timeout'));

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toEqual({ percent: 100, amount: 15000, status: 'PENDIENTE' });
      // La fila se creó antes de llamar: el reembolso queda con rastro.
      expect(prisma.refund.create).toHaveBeenCalled();
      expect(prisma.refund.update).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('un reembolso rechazado por MercadoPago queda RECHAZADO', async () => {
      mercadoPago.refundPayment.mockResolvedValue({
        id: '9002',
        status: 'rejected',
        amount: 15000,
      });

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toMatchObject({ status: 'RECHAZADO' });
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('si la base falla al registrar, no tira y devuelve el monto calculado', async () => {
      prisma.refund.create.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toEqual({ percent: 100, amount: 15000, status: 'PENDIENTE' });
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('REFUND_LOST'),
      );
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
    });

    it('si falla la lectura, no tira', async () => {
      prisma.appointment.findUnique.mockRejectedValue(new Error('down'));

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toMatchObject({ status: 'PENDIENTE' });
    });

    it('un pago aprobado sin id de MercadoPago queda PENDIENTE y registrado', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ payment: { mercadopago_payment_id: null } }),
      );

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toEqual({ percent: 100, amount: 15000, status: 'PENDIENTE' });
      expect(prisma.refund.create).toHaveBeenCalled();
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('REFUND_LOST'),
      );
    });
  });

  describe('quote', () => {
    it('cotiza sin escribir nada ni llamar a MercadoPago', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ scheduled_at: inHours(10) }),
      );

      await expect(service.quote(APPOINTMENT_ID, NOW)).resolves.toEqual({
        percent: 50,
        amount: 7500,
        status: null,
      });
      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
    });
  });
});
