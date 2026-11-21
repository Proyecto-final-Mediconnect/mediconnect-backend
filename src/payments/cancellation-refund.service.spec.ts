import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

jest.mock('@sentry/nestjs', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));
import { Prisma } from '../../generated/prisma/client';
import { PatientNoticesService } from '../notifications/patient-notices.service';
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
            refunds: [],
            ...overrides.payment,
          },
  };
}

describe('CancellationRefundService', () => {
  let service: CancellationRefundService;
  let prisma: {
    appointment: { findUnique: jest.Mock };
    refund: {
      create: jest.Mock;
      update: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      aggregate: jest.Mock;
    };
    payment: { update: jest.Mock };
  };
  let mercadoPago: {
    refundPayment: jest.Mock;
    listRefunds: jest.Mock;
    getRefund: jest.Mock;
  };
  let loggerError: jest.SpyInstance;
  let notices: { refundUpdated: jest.Mock };

  beforeEach(() => {
    prisma = {
      appointment: { findUnique: jest.fn().mockResolvedValue(appointment()) },
      refund: {
        create: jest.fn().mockResolvedValue({ id: 'ref-1' }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
      },
      payment: { update: jest.fn().mockResolvedValue({}) },
    };
    mercadoPago = {
      refundPayment: jest
        .fn()
        .mockResolvedValue({ id: '9001', status: 'approved', amount: 15000 }),
      listRefunds: jest.fn().mockResolvedValue([]),
      getRefund: jest.fn(),
    };
    notices = { refundUpdated: jest.fn().mockResolvedValue(undefined) };
    service = new CancellationRefundService(
      prisma as unknown as PrismaService,
      mercadoPago as unknown as MercadoPagoService,
      notices as unknown as PatientNoticesService,
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
          // ENG-205: cada pedido a MercadoPago queda contado.
          attempts: { increment: 1 },
          last_attempt_at: NOW,
          last_error: null,
        },
      });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-1' },
        data: { status: 'REEMBOLSADO' },
      });
    });

    it('si el webhook ya anotó devolver el pago entero, informa esa y no pide otra (ENG-180)', async () => {
      // El pago entró mientras se cancelaba: el webhook vio el turno cancelado.
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({
          scheduled_at: inHours(10),
          payment: {
            refunds: [
              { amount: new Prisma.Decimal(15000), status: 'PENDIENTE' },
            ],
          },
        }),
      );

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toEqual({ percent: 100, amount: 15000, status: 'PENDIENTE' });
      // La devolución del webhook viaja con el turno: sin consulta aparte.
      expect(prisma.appointment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            payment: {
              select: expect.objectContaining({
                refunds: expect.objectContaining({
                  where: {
                    reason: { startsWith: 'PAGO_SOBRE_TURNO_INACTIVO:' },
                  },
                }),
              }),
            },
          }),
        }),
      );
      expect(prisma.refund.findFirst).not.toHaveBeenCalled();
      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
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
      // El profesional tenía 20 h → 100 %, 12 h → 40 % cuando se reservó. El
      // default (24 h → 100 %, 6 h → 50 %) daría 50 %.
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ scheduled_at: inHours(15), policy: [20, 12, 40] }),
      );

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toMatchObject({ percent: 40, amount: 6000 });
    });

    it('una política congelada fuera de los límites de plataforma se evalúa con el límite (ENG-205)', async () => {
      // Reservado antes de ENG-205 con 72 h → 100 %, 48 h → 20 %. A 30 h del
      // turno, el límite (100 % desde 24 h) le devuelve todo.
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ scheduled_at: inHours(30), policy: [72, 48, 20] }),
      );

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toMatchObject({ percent: 100, amount: 15000 });
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
      // La fila se creó antes de llamar: el reembolso queda con rastro, y con
      // el intento y el error para que el job lo retome (ENG-205).
      expect(prisma.refund.create).toHaveBeenCalled();
      expect(prisma.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref-1' },
        data: {
          attempts: { increment: 1 },
          last_attempt_at: NOW,
          last_error: 'timeout',
        },
      });
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

    it('un pago aprobado sin id de MercadoPago queda RECHAZADO con motivo y avisa (ENG-205)', async () => {
      // Antes quedaba PENDIENTE para siempre, en silencio (hallazgo de ENG-223).
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ payment: { mercadopago_payment_id: null } }),
      );
      prisma.refund.findUnique = jest
        .fn()
        .mockResolvedValue({ reason: 'CANCELACION_PACIENTE' });

      await expect(
        service.refundCancellation(APPOINTMENT_ID, NOW),
      ).resolves.toEqual({ percent: 100, amount: 15000, status: 'RECHAZADO' });
      expect(prisma.refund.create).toHaveBeenCalled();
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
      expect(prisma.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref-1' },
        data: expect.objectContaining({
          status: 'RECHAZADO',
          reason: expect.stringMatching(
            /^CANCELACION_PACIENTE \| .*ID de MercadoPago/,
          ),
        }),
      });
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Reembolso rechazado: requiere gestión manual',
        expect.objectContaining({ level: 'error' }),
      );
    });
  });

  describe('retryPending (ENG-205)', () => {
    /** Un reembolso pendiente creado hace `horas` horas. */
    function pendiente(horas: number, extra: Record<string, unknown> = {}) {
      return {
        id: 'ref-9',
        amount: new Prisma.Decimal('15000.00'),
        reason: 'CANCELACION_PACIENTE',
        attempts: 1,
        last_attempt_at: new Date(NOW.getTime() - 60 * 60_000),
        created_at: new Date(NOW.getTime() - horas * 3_600_000),
        mercadopago_refund_id: null,
        payment: {
          id: 'pay-1',
          amount: new Prisma.Decimal('15000.00'),
          mercadopago_payment_id: 'mp-123',
          appointment_id: 'appt-9',
        },
        ...extra,
      };
    }

    beforeEach(() => {
      Object.assign(prisma.refund, {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest
          .fn()
          .mockResolvedValue({ reason: 'CANCELACION_PACIENTE' }),
        aggregate: jest.fn().mockResolvedValue({
          _sum: { amount: new Prisma.Decimal('15000.00') },
        }),
      });
      Object.assign(mercadoPago, {
        listRefunds: jest.fn().mockResolvedValue([]),
        getRefund: jest.fn(),
      });
    });

    it('reintenta con la misma clave y, si se aprueba, lo procesa y marca el pago', async () => {
      prisma.refund.findMany
        .mockResolvedValueOnce([pendiente(2)])
        .mockResolvedValue([]);

      const summary = await service.retryPending(NOW);

      expect(summary).toEqual({ revisados: 1, procesados: 1, rechazados: 0 });
      expect(mercadoPago.refundPayment).toHaveBeenCalledWith(
        'mp-123',
        15000,
        'refund-ref-9',
      );
      expect(prisma.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref-9' },
        data: expect.objectContaining({
          status: 'PROCESADO',
          mercadopago_refund_id: '9001',
          attempts: { increment: 1 },
        }),
      });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-1' },
        data: { status: 'REEMBOLSADO' },
      });
      // ENG-208: el paciente se entera.
      expect(notices.refundUpdated).toHaveBeenCalledWith(
        'appt-9',
        { refundId: 'ref-9', amount: 15000, status: 'PROCESADO' },
        NOW,
      );
    });

    it('si MercadoPago ya lo tenía, lo asocia y no lo pide de nuevo', async () => {
      prisma.refund.findMany
        .mockResolvedValueOnce([pendiente(30)])
        .mockResolvedValue([]);
      (
        mercadoPago as unknown as { listRefunds: jest.Mock }
      ).listRefunds.mockResolvedValue([
        { id: '777', status: 'approved', amount: 15000 },
      ]);

      await service.retryPending(NOW);

      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
      expect(prisma.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref-9' },
        data: expect.objectContaining({
          status: 'PROCESADO',
          mercadopago_refund_id: '777',
        }),
      });
    });

    it('uno ya pedido que quedó en proceso se consulta, no se vuelve a pedir', async () => {
      prisma.refund.findMany.mockResolvedValueOnce([
        pendiente(3, { mercadopago_refund_id: '555' }),
      ]);
      (
        mercadoPago as unknown as { getRefund: jest.Mock }
      ).getRefund.mockResolvedValue({
        id: '555',
        status: 'in_process',
        amount: 15000,
      });

      const summary = await service.retryPending(NOW);

      expect(summary).toEqual({ revisados: 1, procesados: 0, rechazados: 0 });
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
      expect(prisma.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref-9' },
        data: expect.objectContaining({
          status: 'PENDIENTE',
          processed_at: null,
        }),
      });
    });

    it('respeta la espera entre intentos', async () => {
      prisma.refund.findMany.mockResolvedValueOnce([
        // 3 intentos → espera de 1 h; el último fue hace 10 minutos.
        pendiente(2, {
          attempts: 3,
          last_attempt_at: new Date(NOW.getTime() - 10 * 60_000),
        }),
      ]);

      const summary = await service.retryPending(NOW);

      expect(summary.revisados).toBe(0);
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
    });

    it('pasadas 48 h sin confirmar, queda RECHAZADO con motivo y avisa', async () => {
      prisma.refund.findMany.mockResolvedValueOnce([pendiente(49)]);

      const summary = await service.retryPending(NOW);

      expect(summary).toEqual({ revisados: 1, procesados: 0, rechazados: 1 });
      // Pasado el plazo no se pide otro: podría devolver dos veces.
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
      expect(prisma.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref-9' },
        data: expect.objectContaining({ status: 'RECHAZADO' }),
      });
      expect(Sentry.captureMessage).toHaveBeenCalled();
      expect(notices.refundUpdated).toHaveBeenCalledWith(
        'appt-9',
        expect.objectContaining({ status: 'RECHAZADO' }),
        NOW,
      );
    });

    it('si MercadoPago falla, guarda el error y sigue pendiente', async () => {
      prisma.refund.findMany.mockResolvedValueOnce([pendiente(2)]);
      mercadoPago.refundPayment.mockRejectedValue(
        new Error('503 de MercadoPago'),
      );

      const summary = await service.retryPending(NOW);

      expect(summary).toEqual({ revisados: 1, procesados: 0, rechazados: 0 });
      expect(prisma.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref-9' },
        data: {
          attempts: { increment: 1 },
          last_attempt_at: NOW,
          last_error: '503 de MercadoPago',
        },
      });
      // Sigue pendiente: todavía no hay nada que avisar.
      expect(notices.refundUpdated).not.toHaveBeenCalled();
    });

    it('un reembolso de un pago sobre turno inactivo reintenta con su clave original', async () => {
      prisma.refund.findMany.mockResolvedValueOnce([
        pendiente(2, { reason: 'PAGO_SOBRE_TURNO_INACTIVO:mp-123' }),
      ]);

      await service.retryPending(NOW);

      expect(mercadoPago.refundPayment).toHaveBeenCalledWith(
        'mp-123',
        15000,
        'unapplied-mp-123',
      );
    });
  });

  describe('refundInFull (ENG-204)', () => {
    it('devuelve el 100 % aunque la política diera menos, con el motivo del profesional', async () => {
      // A 2 h del turno la política default no devuelve nada.
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ scheduled_at: inHours(2) }),
      );

      const result = await service.refundInFull(
        APPOINTMENT_ID,
        NOW,
        'CANCELACION_PROFESIONAL',
      );

      expect(result).toEqual({
        percent: 100,
        amount: 15000,
        status: 'PROCESADO',
      });
      expect(prisma.refund.create).toHaveBeenCalledWith({
        data: {
          payment_id: 'pay-1',
          amount: new Prisma.Decimal('15000'),
          reason: 'CANCELACION_PROFESIONAL',
        },
      });
      expect(mercadoPago.refundPayment).toHaveBeenCalledWith(
        'mp-123',
        15000,
        'refund-ref-1',
      );
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-1' },
        data: { status: 'REEMBOLSADO' },
      });
    });

    it('usa el motivo de vencimiento cuando lo pide el job', async () => {
      await service.refundInFull(
        APPOINTMENT_ID,
        NOW,
        'VENCIMIENTO_REPROGRAMACION',
      );

      expect(prisma.refund.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ reason: 'VENCIMIENTO_REPROGRAMACION' }),
      });
    });

    it('sin pago aprobado no devuelve nada', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ payment: { status: 'PENDIENTE' } }),
      );

      const result = await service.refundInFull(
        APPOINTMENT_ID,
        NOW,
        'CANCELACION_PROFESIONAL',
      );

      expect(result).toEqual({ percent: 100, amount: 0, status: null });
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
    });

    it('si otro camino ya registró el reembolso total, informa ese y no pide otro', async () => {
      prisma.refund.create.mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      );
      prisma.refund.findFirst.mockResolvedValue({
        amount: new Prisma.Decimal('15000'),
        status: 'PROCESADO',
      });

      const result = await service.refundInFull(
        APPOINTMENT_ID,
        NOW,
        'VENCIMIENTO_REPROGRAMACION',
      );

      expect(result).toEqual({
        percent: 100,
        amount: 15000,
        status: 'PROCESADO',
      });
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
      expect(loggerError).not.toHaveBeenCalled();
    });

    it('nunca tira: si la lectura falla, queda PENDIENTE y va a Sentry', async () => {
      prisma.appointment.findUnique.mockRejectedValue(new Error('db caída'));

      const result = await service.refundInFull(
        APPOINTMENT_ID,
        NOW,
        'CANCELACION_PROFESIONAL',
      );

      expect(result).toEqual({ percent: 100, amount: 0, status: 'PENDIENTE' });
      expect(Sentry.captureException).toHaveBeenCalled();
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
        select: expect.any(Object),
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
      prisma.refund.findFirst.mockResolvedValue({
        id: 'ref-1',
        status: 'PROCESADO',
        created_at: NOW,
      });

      await expect(
        service.refundUnappliedPayment(DUPLICATE, NOW),
      ).resolves.toBe('PROCESADO');

      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
    });

    it('una fila PENDIENTE se reintenta con la misma fila y la misma clave', async () => {
      prisma.refund.findFirst.mockResolvedValue({
        id: 'ref-viejo',
        status: 'PENDIENTE',
        created_at: new Date(NOW.getTime() - 3_600_000),
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
      expect(prisma.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref-viejo' },
        data: expect.objectContaining({ status: 'PROCESADO' }),
      });
    });

    it('pasadas las 24 h de la clave no reintenta: avisa para devolverlo a mano', async () => {
      prisma.refund.findFirst.mockResolvedValue({
        id: 'ref-viejo',
        status: 'PENDIENTE',
        created_at: new Date(NOW.getTime() - 25 * 3_600_000),
      });

      await expect(
        service.refundUnappliedPayment(DUPLICATE, NOW),
      ).resolves.toBe('PENDIENTE');

      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalled();
    });

    it('dos entregas concurrentes: la que pierde el índice único sigue con la fila de la otra', async () => {
      prisma.refund.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'ref-otra',
          status: 'PROCESADO',
          created_at: NOW,
        });
      prisma.refund.create.mockRejectedValue({ code: 'P2002' });

      await expect(
        service.refundUnappliedPayment(DUPLICATE, NOW),
      ).resolves.toBe('PROCESADO');

      expect(mercadoPago.refundPayment).not.toHaveBeenCalled();
      expect(prisma.refund.update).not.toHaveBeenCalled();
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
