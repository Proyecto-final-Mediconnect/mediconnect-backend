import { createHmac } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { buildManifest } from './mercadopago-signature';
import type { MercadoPagoPayment } from './mercadopago.service';
import {
  IncomingWebhook,
  PaymentWebhookService,
} from './payment-webhook.service';

const SECRET = 'webhook-secret';
const NOW = new Date('2026-10-01T15:00:00Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const APPOINTMENT_ID = '11111111-1111-1111-1111-111111111111';
const MP_PAYMENT_ID = '123456789';

function signed(overrides: Partial<IncomingWebhook> = {}): IncomingWebhook {
  const requestId = 'req-1';
  const v1 = createHmac('sha256', SECRET)
    .update(buildManifest(MP_PAYMENT_ID, requestId, TS))
    .digest('hex');
  return {
    signatureHeader: `ts=${TS},v1=${v1}`,
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
    paymentWebhookEvent: { create: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let mercadopago: { getPayment: jest.Mock };
  let service: PaymentWebhookService;

  beforeEach(() => {
    prisma = {
      payment: {
        findUnique: jest.fn().mockResolvedValue(PAYMENT_ROW),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      appointment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
    service = new PaymentWebhookService(prisma as never, mercadopago as never);
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
  });

  it('monto menor al del turno: no confirma', async () => {
    mercadopago.getPayment.mockResolvedValue(
      mpPayment({ transactionAmount: 100 }),
    );

    await expect(service.handle(signed(), SECRET, NOW)).resolves.toBe(
      'monto-no-coincide',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
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

  it('si la API de MercadoPago falla, propaga el error para que reintente', async () => {
    mercadopago.getPayment.mockRejectedValue(new Error('timeout'));

    await expect(service.handle(signed(), SECRET, NOW)).rejects.toThrow(
      'timeout',
    );
    expect(prisma.paymentWebhookEvent.create).not.toHaveBeenCalled();
  });
});
