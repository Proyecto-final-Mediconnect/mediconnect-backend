import { createHmac } from 'node:crypto';
import * as Sentry from '@sentry/nestjs';

jest.mock('@sentry/nestjs', () => ({ captureMessage: jest.fn() }));
import { Prisma } from '../../generated/prisma/client';
import { buildManifest } from './mercadopago-signature';
import { HttpStatus } from '@nestjs/common';
import {
  MercadoPagoApiError,
  type MercadoPagoPayment,
} from './mercadopago.service';
import {
  IncomingWebhook,
  PaymentWebhookService,
} from './payment-webhook.service';

const SECRET = 'webhook-secret';
const NOW = new Date('2026-10-01T15:00:00Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const APPOINTMENT_ID = '11111111-1111-1111-1111-111111111111';
const MP_PAYMENT_ID = '123456789';

function signed(
  overrides: Partial<IncomingWebhook> = {},
  ts = TS,
): IncomingWebhook {
  const requestId = 'req-1';
  const v1 = createHmac('sha256', SECRET)
    .update(buildManifest(MP_PAYMENT_ID, requestId, ts))
    .digest('hex');
  return {
    signatureHeader: `ts=${ts},v1=${v1}`,
    requestId,
    dataId: MP_PAYMENT_ID,
    topic: 'payment',
    payload: { type: 'payment', data: { id: MP_PAYMENT_ID } },
    ...overrides,
  };
}

function mpPayment(
  overrides: Partial<MercadoPagoPayment> = {},
): MercadoPagoPayment {
  return {
    id: MP_PAYMENT_ID,
    status: 'approved',
    statusDetail: 'accredited',
    transactionAmount: 15000,
    currencyId: 'ARS',
    externalReference: APPOINTMENT_ID,
    paymentMethodId: 'visa',
    approvedAt: '2026-10-01T14:59:00Z',
    ...overrides,
  };
}

const PAYMENT_ROW = {
  id: 'pay-1',
  appointment_id: APPOINTMENT_ID,
  amount: new Prisma.Decimal('15000.00'),
  currency: 'ARS',
  status: 'PENDIENTE',
};

describe('PaymentWebhookService', () => {
  let prisma: {
    payment: { findUnique: jest.Mock; updateMany: jest.Mock };
    appointment: { updateMany: jest.Mock };
    refund: { createMany: jest.Mock };
    paymentWebhookEvent: { create: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let mercadopago: { getPayment: jest.Mock };
  let notifications: { sendConfirmation: jest.Mock };
  let inApp: { notifyProfessional: jest.Mock };
  let refunds: { refundUnappliedPayment: jest.Mock };
  let service: PaymentWebhookService;

  beforeEach(() => {
    prisma = {
      payment: {
        findUnique: jest.fn().mockResolvedValue(PAYMENT_ROW),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      appointment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      refund: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      paymentWebhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    mercadopago = { getPayment: jest.fn().mockResolvedValue(mpPayment()) };
    notifications = {
      sendConfirmation: jest.fn().mockResolvedValue(undefined),
    };
    inApp = { notifyProfessional: jest.fn().mockResolvedValue(undefined) };
    refunds = {
      refundUnappliedPayment: jest.fn().mockResolvedValue('PROCESADO'),
    };
    (Sentry.captureMessage as jest.Mock).mockClear();
    service = new PaymentWebhookService(
      prisma as never,
      mercadopago as never,
      notifications as never,
      inApp as never,
      refunds as never,
    );
  });

  it('pago aprobado: marca el Payment APROBADO y confirma el turno', async () => {
    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'turno-confirmado',
    );

    expect(mercadopago.getPayment).toHaveBeenCalledWith(MP_PAYMENT_ID);
    expect(prisma.payment.findUnique).toHaveBeenCalledWith({
      where: { appointment_id: APPOINTMENT_ID },
    });
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: { in: ['PENDIENTE', 'RECHAZADO'] } },
      data: expect.objectContaining({
        status: 'APROBADO',
        mercadopago_payment_id: MP_PAYMENT_ID,
        method: 'visa',
        confirmed_at: new Date('2026-10-01T14:59:00Z'),
      }),
    });
    expect(prisma.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: APPOINTMENT_ID, status: 'RESERVADO_SIN_PAGAR' },
      data: { status: 'CONFIRMADO', updated_at: NOW },
    });
    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payment_id: 'pay-1',
        mercadopago_payment_id: MP_PAYMENT_ID,
      }),
    });
    expect(prisma.paymentWebhookEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt-1' },
      data: { processed: true, processed_at: NOW },
    });
  });

  it('firma inválida: no consulta a MercadoPago ni escribe en la base', async () => {
    const outcome = await service.handle(
      signed({ signatureHeader: `ts=${TS},v1=${'0'.repeat(64)}` }),
      SECRET,
      NOW,
    );

    expect(outcome).toBe('firma-invalida');
    expect(mercadopago.getPayment).not.toHaveBeenCalled();
    expect(prisma.paymentWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('sin secreto configurado: descarta sin verificar', async () => {
    await expect(service.handle(signed(), undefined, NOW)).resolves.toBe(
      'sin-secreto-configurado',
    );
    expect(mercadopago.getPayment).not.toHaveBeenCalled();
  });

  it('notificación de otro tipo (merchant_order): se ignora', async () => {
    await expect(
      service.handle(signed({ topic: 'merchant_order' }), SECRET, NOW),
    ).resolves.toBe('tipo-ignorado');
    expect(mercadopago.getPayment).not.toHaveBeenCalled();
  });

  it('webhook duplicado: si el Payment ya estaba APROBADO no toca el turno', async () => {
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'ya-procesado',
    );
    expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
  });

  it('pago aprobado de un turno ya cancelado: no lo revive', async () => {
    prisma.appointment.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'turno-no-confirmable',
    );
    // Y no se le confirma por mail un turno que no se confirmó.
    expect(notifications.sendConfirmation).not.toHaveBeenCalled();
    expect(inApp.notifyProfessional).not.toHaveBeenCalled();
  });

  describe('pagos que no se aplican a un turno (ENG-144)', () => {
    it('pago aprobado de un turno ya cancelado: se devuelve entero y la fila queda REEMBOLSADO', async () => {
      prisma.appointment.updateMany.mockResolvedValue({ count: 0 });

      await service.handle(signed(), SECRET, NOW);

      expect(refunds.refundUnappliedPayment).toHaveBeenCalledWith(
        {
          paymentId: 'pay-1',
          mpPaymentId: MP_PAYMENT_ID,
          amount: 15000,
          reason: 'PAGO_SOBRE_TURNO_INACTIVO',
          markPaymentRefunded: true,
        },
        NOW,
      );
    });

    it('un segundo pago aprobado con otro id es un duplicado: se devuelve sin tocar el primero', async () => {
      // La fila ya quedó APROBADO con el primer pago.
      prisma.payment.updateMany.mockResolvedValue({ count: 0 });
      prisma.payment.findUnique
        .mockResolvedValueOnce(PAYMENT_ROW)
        .mockResolvedValueOnce({
          status: 'APROBADO',
          mercadopago_payment_id: 'primer-pago',
        });

      await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
        'pago-duplicado',
      );

      expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
      expect(refunds.refundUnappliedPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          mpPaymentId: MP_PAYMENT_ID,
          reason: 'PAGO_DUPLICADO',
          markPaymentRefunded: false,
        }),
        NOW,
      );
      expect(notifications.sendConfirmation).not.toHaveBeenCalled();
    });

    it('la misma notificación repetida sigue siendo idempotente: no es un duplicado', async () => {
      prisma.payment.updateMany.mockResolvedValue({ count: 0 });
      prisma.payment.findUnique
        .mockResolvedValueOnce(PAYMENT_ROW)
        .mockResolvedValueOnce({
          status: 'APROBADO',
          mercadopago_payment_id: MP_PAYMENT_ID,
        });

      await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
        'ya-procesado',
      );
      expect(refunds.refundUnappliedPayment).not.toHaveBeenCalled();
    });

    it('turno no confirmable: anota la devolución pendiente en la misma transacción', async () => {
      prisma.appointment.updateMany.mockResolvedValue({ count: 0 });

      await service.handle(signed(), SECRET, NOW);

      expect(prisma.refund.createMany).toHaveBeenCalledWith({
        data: [
          {
            payment_id: 'pay-1',
            amount: new Prisma.Decimal(15000),
            reason: `PAGO_SOBRE_TURNO_INACTIVO:${MP_PAYMENT_ID}`,
          },
        ],
        skipDuplicates: true,
      });
    });

    describe('reintento en ya-procesado', () => {
      function retried(current: unknown) {
        prisma.payment.updateMany.mockResolvedValue({ count: 0 });
        prisma.payment.findUnique
          .mockResolvedValueOnce(PAYMENT_ROW)
          .mockResolvedValueOnce({
            status: 'APROBADO',
            mercadopago_payment_id: MP_PAYMENT_ID,
          })
          .mockResolvedValueOnce(current);
      }

      it('si el proceso murió antes de devolver, el reintento de MercadoPago lo devuelve', async () => {
        retried({
          status: 'APROBADO',
          mercadopago_payment_id: MP_PAYMENT_ID,
          appointment: { status: 'CANCELADO' },
          refunds: [
            {
              reason: `PAGO_SOBRE_TURNO_INACTIVO:${MP_PAYMENT_ID}`,
              status: 'PENDIENTE',
            },
          ],
        });

        await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
          'ya-procesado',
        );
        expect(refunds.refundUnappliedPayment).toHaveBeenCalledWith(
          {
            paymentId: 'pay-1',
            mpPaymentId: MP_PAYMENT_ID,
            amount: 15000,
            reason: 'PAGO_SOBRE_TURNO_INACTIVO',
            markPaymentRefunded: true,
          },
          NOW,
        );
      });

      it('turno confirmado y cancelado con reembolso de ENG-65: no devuelve de nuevo', async () => {
        retried({
          status: 'APROBADO',
          mercadopago_payment_id: MP_PAYMENT_ID,
          appointment: { status: 'CANCELADO' },
          refunds: [{ reason: 'CANCELACION_PACIENTE', status: 'PROCESADO' }],
        });

        await service.handle(signed(), SECRET, NOW);

        expect(refunds.refundUnappliedPayment).not.toHaveBeenCalled();
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
      });

      it('turno cancelado sin ninguna devolución: no adivina, avisa a Sentry', async () => {
        retried({
          status: 'APROBADO',
          mercadopago_payment_id: MP_PAYMENT_ID,
          appointment: { status: 'CANCELADO' },
          refunds: [],
        });

        await service.handle(signed(), SECRET, NOW);

        expect(refunds.refundUnappliedPayment).not.toHaveBeenCalled();
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ level: 'error' }),
        );
      });

      it('turno confirmado: no hay nada que devolver', async () => {
        retried({
          status: 'APROBADO',
          mercadopago_payment_id: MP_PAYMENT_ID,
          appointment: { status: 'CONFIRMADO' },
          refunds: [],
        });

        await service.handle(signed(), SECRET, NOW);

        expect(refunds.refundUnappliedPayment).not.toHaveBeenCalled();
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
      });
    });

    it('un turno confirmado normal no devuelve nada', async () => {
      await service.handle(signed(), SECRET, NOW);

      expect(refunds.refundUnappliedPayment).not.toHaveBeenCalled();
    });
  });

  it('al confirmar el turno avisa in-app al profesional (ENG-69)', async () => {
    await service.handle(signed(), SECRET, NOW);

    expect(inApp.notifyProfessional).toHaveBeenCalledWith(
      APPOINTMENT_ID,
      'PAGO_CONFIRMADO',
      NOW,
    );
  });

  it('al confirmar el turno manda el email de confirmación (ENG-68)', async () => {
    await service.handle(signed(), SECRET, NOW);

    expect(notifications.sendConfirmation).toHaveBeenCalledWith(
      APPOINTMENT_ID,
      NOW,
    );
  });

  it('no espera al mail para contestarle a MercadoPago', async () => {
    notifications.sendConfirmation.mockReturnValue(new Promise(() => {}));

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'turno-confirmado',
    );
  });

  it('un webhook repetido no vuelve a mandar la confirmación', async () => {
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'ya-procesado',
    );
    expect(notifications.sendConfirmation).not.toHaveBeenCalled();
    expect(inApp.notifyProfessional).not.toHaveBeenCalled();
  });

  it('monto menor al del turno: no confirma', async () => {
    mercadopago.getPayment.mockResolvedValue(
      mpPayment({ transactionAmount: 100 }),
    );

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'monto-no-coincide',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({
          paymentId: 'pay-1',
          mpPaymentId: MP_PAYMENT_ID,
          paidAmount: 100,
          expectedAmount: '15000',
        }),
      }),
    );
    // Es el primer pago del turno, no un duplicado: queda para revisar a mano.
    expect(refunds.refundUnappliedPayment).not.toHaveBeenCalled();
  });

  it('segundo pago por menos plata con otro id: se devuelve como duplicado', async () => {
    mercadopago.getPayment.mockResolvedValue(
      mpPayment({ transactionAmount: 100 }),
    );
    prisma.payment.findUnique.mockResolvedValue({
      ...PAYMENT_ROW,
      status: 'APROBADO',
      mercadopago_payment_id: 'primer-pago',
    });

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'monto-no-coincide',
    );
    expect(refunds.refundUnappliedPayment).toHaveBeenCalledWith(
      {
        paymentId: 'pay-1',
        mpPaymentId: MP_PAYMENT_ID,
        amount: 100,
        reason: 'PAGO_DUPLICADO',
        markPaymentRefunded: false,
      },
      NOW,
    );
  });

  it('moneda distinta: no confirma', async () => {
    mercadopago.getPayment.mockResolvedValue(mpPayment({ currencyId: 'USD' }));

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'monto-no-coincide',
    );
  });

  it('pago rechazado: marca RECHAZADO solo si seguía PENDIENTE y no toca el turno', async () => {
    mercadopago.getPayment.mockResolvedValue(
      mpPayment({ status: 'rejected', approvedAt: null }),
    );

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'pago-rechazado',
    );
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: 'PENDIENTE' },
      data: expect.objectContaining({ status: 'RECHAZADO' }),
    });
    expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
  });

  it('pago reembolsado: marca REEMBOLSADO solo si estaba APROBADO (ENG-65)', async () => {
    mercadopago.getPayment.mockResolvedValue(mpPayment({ status: 'refunded' }));

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'pago-reembolsado',
    );
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'pay-1',
        status: 'APROBADO',
        mercadopago_payment_id: MP_PAYMENT_ID,
      },
      data: { status: 'REEMBOLSADO' },
    });
    expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
  });

  it('pago pendiente: solo queda en la bitácora', async () => {
    mercadopago.getPayment.mockResolvedValue(
      mpPayment({ status: 'in_process', approvedAt: null }),
    );

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'pago-pendiente',
    );
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalled();
  });

  it('pago sin Payment asociado: queda en la bitácora sin procesar', async () => {
    prisma.payment.findUnique.mockResolvedValue(null);

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'pago-desconocido',
    );
    expect(prisma.paymentWebhookEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt-1' },
      data: { processed: false, processed_at: NOW },
    });
  });

  it('pago sin external_reference: no busca en la base', async () => {
    mercadopago.getPayment.mockResolvedValue(
      mpPayment({ externalReference: null }),
    );

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'pago-desconocido',
    );
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
  });

  // Un reintento de MercadoPago llega 15 minutos o más después. Si conservara
  // el ts original y se rechazara por viejo, el turno cobrado no se confirmaría.
  it('una firma de hace horas (reintento) se procesa igual', async () => {
    const threeHoursAgo = String(Math.floor(NOW.getTime() / 1000) - 3 * 3600);

    await expect(
      service.handle(signed({}, threeHoursAgo), SECRET, NOW),
    ).resolves.toBe('turno-confirmado');
  });

  it('pago que MercadoPago no encuentra (404): 200 sin reintento, no un 5xx', async () => {
    mercadopago.getPayment.mockRejectedValue(
      new MercadoPagoApiError(404, HttpStatus.BAD_GATEWAY, 'no existe'),
    );

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'pago-desconocido',
    );
    expect(prisma.paymentWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('un error del proveedor que no es 404 se propaga para que reintente', async () => {
    mercadopago.getPayment.mockRejectedValue(
      new MercadoPagoApiError(500, HttpStatus.BAD_GATEWAY, 'caído'),
    );

    await expect(service.handle(signed(), SECRET, NOW)).rejects.toBeInstanceOf(
      MercadoPagoApiError,
    );
  });

  it('si la API de MercadoPago falla, propaga el error para que reintente', async () => {
    mercadopago.getPayment.mockRejectedValue(new Error('timeout'));

    await expect(service.handle(signed(), SECRET, NOW)).rejects.toThrow(
      'timeout',
    );
    expect(prisma.paymentWebhookEvent.create).not.toHaveBeenCalled();
  });
});
