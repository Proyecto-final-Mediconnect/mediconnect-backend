import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsWebhookController } from './payments-webhook.controller';

/**
 * El controller no decide nada: arma el `IncomingWebhook` y se lo pasa al
 * service. Lo que se prueba es justamente ese armado, porque de acá sale el
 * `data.id` sobre el que se verifica la firma y el `topic` que filtra qué se
 * procesa.
 */
describe('PaymentsWebhookController', () => {
  const SECRET = 'secreto-de-webhook';

  let controller: PaymentsWebhookController;
  let handle: jest.Mock;

  function req(headers: Record<string, string | string[]> = {}): Request {
    return { headers } as unknown as Request;
  }

  beforeEach(() => {
    handle = jest.fn().mockResolvedValue('turno-confirmado');
    const config = {
      get: (key: string) =>
        key === 'MERCADOPAGO_WEBHOOK_SECRET' ? SECRET : undefined,
    } as unknown as ConfigService;
    controller = new PaymentsWebhookController(
      { handle } as unknown as PaymentWebhookService,
      config,
    );
  });

  it('pasa los headers de firma, el data.id y el type del query, y el secreto', async () => {
    const payload = { type: 'payment', data: { id: '999' } };

    await expect(
      controller.receive(
        req({ 'x-signature': 'ts=1,v1=abc', 'x-request-id': 'req-1' }),
        '123',
        undefined,
        'payment',
        undefined,
        payload,
      ),
    ).resolves.toEqual({ resultado: 'turno-confirmado' });

    expect(handle).toHaveBeenCalledWith(
      {
        signatureHeader: 'ts=1,v1=abc',
        requestId: 'req-1',
        dataId: '123',
        topic: 'payment',
        payload,
      },
      SECRET,
    );
  });

  it('formato IPN: toma `id` y `topic` del query', async () => {
    await controller.receive(
      req(),
      undefined,
      '456',
      undefined,
      'merchant_order',
      {},
    );

    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ dataId: '456', topic: 'merchant_order' }),
      SECRET,
    );
  });

  it('sin query, toma el id y el type del body (también si el id es numérico)', async () => {
    await controller.receive(
      req(),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        type: 'payment',
        data: { id: 789 },
      },
    );

    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ dataId: '789', topic: 'payment' }),
      SECRET,
    );
  });

  it('el data.id del query gana sobre el del body', async () => {
    // La firma se calcula sobre el id del query: uno distinto en el body no
    // puede reemplazarlo.
    await controller.receive(req(), '123', undefined, undefined, undefined, {
      data: { id: '999' },
    });

    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ dataId: '123' }),
      SECRET,
    );
  });

  it('header repetido: usa el primer valor', async () => {
    await controller.receive(
      req({ 'x-signature': ['ts=1,v1=a', 'ts=2,v1=b'] }),
      '123',
      undefined,
      undefined,
      undefined,
      {},
    );

    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ signatureHeader: 'ts=1,v1=a' }),
      SECRET,
    );
  });

  it('body que no es un objeto: no rompe y no inventa id ni topic', async () => {
    await controller.receive(
      req(),
      undefined,
      undefined,
      undefined,
      undefined,
      'basura',
    );

    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ dataId: undefined, topic: undefined }),
      SECRET,
    );
  });
});
