import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

jest.mock('@sentry/nestjs', () => ({ captureMessage: jest.fn() }));
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
    refund: { create: jest.Mock; update: jest.Mock; findFirst: jest.Mock };
    payment: { update: jest.Mock };
  };
  let mercadoPago: { refundPayment: jest.Mock };

  beforeEach(() => {
    prisma = {
      appointment: { findUnique: jest.fn().mockResolvedValue(appointment()) },
      refund: {
        create: jest.fn().mockResolvedValue({ id: 'ref-1' }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
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
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
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

    it('si la base falla, no tira', async () => {
      prisma.refund.create.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toMatchObject({ status: 'PENDIENTE' });
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

  describe('refundUnappliedPayment (ENG-144)', () => {
    const DUPLICATE = {
      paymentId: 'pay-1',
      mpPaymentId: 'mp-segundo',
      amount: 15000,
      reason: 'PAGO_DUPLICADO' as const,
      markPaymentRefunded: false,
    };

    beforeEach(() => {
      (Sentry.captureMessage as jest.Mock).mockClear();
    });

    it('devuelve el pago entero, con una clave fija por pago de MercadoPago', async () => {
      await expect(
        service.refundUnappliedPayment(DUPLICATE, NOW),
      ).resolves.toBe('PROCESADO');

      expect(prisma.refund.create).toHaveBeenCalledWith({
        data: {
          payment_id: 'pay-1',
          amount: new Prisma.Decimal(15000),
          reason: 'PAGO_DUPLICADO:mp-segundo',
        },
        select: { id: true },
      });
      expect(mercadoPago.refundPayment).toHaveBeenCalledWith(
        'mp-segundo',
        15000,
        'unapplied-mp-segundo',
      );
      expect(prisma.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref-1' },
        data: {
          status: 'PROCESADO',
          mercadopago_refund_id: '9001',
          processed_at: NOW,
        },
      });
    });

    it('el duplicado no toca la fila del turno: es del primer pago, que sigue valiendo', async () => {
      await service.refundUnappliedPayment(DUPLICATE, NOW);

      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('el pago sobre un turno inactivo sí deja la fila REEMBOLSADO', async () => {
      await service.refundUnappliedPayment(
        {
          ...DUPLICATE,
          reason: 'PAGO_SOBRE_TURNO_INACTIVO',
          markPaymentRefunded: true,
        },
        NOW,
      );

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-1' },
        data: { status: 'REEMBOLSADO' },
      });
    });

    it('si el webhook se repite no pide otra devolución', async () => {
      prisma.refund.findFirst.mockResolvedValue({ status: 'PROCESADO' });

      await expect(
        service.refundUnappliedPayment(DUPLICATE, NOW),
      ).resolves.toBe('PROCESADO');

      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
    });

    it('si la fila quedó PENDIENTE hace menos de 24 h, reintenta con la misma clave y actualiza esa fila', async () => {
      prisma.refund.findFirst.mockResolvedValue({
        id: 'ref-viejo',
        status: 'PENDIENTE',
        created_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      });

      await expect(
        service.refundUnappliedPayment(DUPLICATE, NOW),
      ).resolves.toBe('PROCESADO');

      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(mercadoPago.refundPayment).toHaveBeenCalledWith(
        'mp-segundo',
        15000,
        'unapplied-mp-segundo',
      );
      expect(prisma.refund.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ref-viejo' } }),
      );
    });

    it('si la fila sin procesar tiene más de 24 h no reintenta (la clave venció) y avisa a Sentry', async () => {
      prisma.refund.findFirst.mockResolvedValue({
        id: 'ref-viejo',
        status: 'RECHAZADO',
        created_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
      });

      await expect(
        service.refundUnappliedPayment(DUPLICATE, NOW),
      ).resolves.toBe('RECHAZADO');

      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
      expect(prisma.refund.update).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('24 h'),
        expect.objectContaining({ level: 'error' }),
      );
    });

    it('si otra entrega concurrente creó la fila (P2002), devuelve su estado sin llamar a MercadoPago', async () => {
      prisma.refund.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ status: 'PENDIENTE' });
      prisma.refund.create.mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      );

      await expect(
        service.refundUnappliedPayment(DUPLICATE, NOW),
      ).resolves.toBe('PENDIENTE');

      expect(prisma.refund.findFirst).toHaveBeenCalledTimes(2);
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('si MercadoPago falla queda PENDIENTE y avisa a Sentry para devolverlo a mano, sin tirar', async () => {
      mercadoPago.refundPayment.mockRejectedValue(new Error('mp caído'));

      await expect(
        service.refundUnappliedPayment(DUPLICATE, NOW),
      ).resolves.toBe('PENDIENTE');

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('PAGO_DUPLICADO'),
        expect.objectContaining({
          extra: { mpPaymentId: 'mp-segundo', status: 'PENDIENTE' },
        }),
      );
    });

    it('si ni siquiera puede escribir la fila, igual avisa y no tira', async () => {
      prisma.refund.findFirst.mockRejectedValue(new Error('base caída'));

      await expect(
        service.refundUnappliedPayment(DUPLICATE, NOW),
      ).resolves.toBe('PENDIENTE');
      expect(Sentry.captureMessage).toHaveBeenCalled();
    });
  });
});
