import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { PaymentsSpikeController } from './payments-spike.controller';
import { buildManifest } from './mercadopago-signature';
import { SPIKE_EXTERNAL_REFERENCE_PREFIX } from './mercadopago.config';
import type { MercadoPagoService } from './mercadopago.service';

/**
 * El banco de pruebas de ENG-61. Lo que importa verificar acá son las dos
 * salvaguardas que el spike agrega sobre el service: que nunca corra contra
 * credenciales productivas, y que el endpoint público conteste 200 aunque
 * rechace la firma.
 */
describe('PaymentsSpikeController', () => {
  const SECRET = 'secreto-de-webhook';
  const USER_ID = '8e5b1153-9809-45a9-9803-5aa33e1f1058';
  const DATA_ID = '1234567890';
  const REQUEST_ID = 'req-abc-123';

  let controller: PaymentsSpikeController;
  let mercadopago: jest.Mocked<
    Pick<
      MercadoPagoService,
      'isConfigured' | 'isSandbox' | 'createPreference' | 'getPayment'
    >
  >;
  let env: Record<string, string | undefined>;

  /** Request con la sesión que dejaría `JwtAuthGuard`. */
  function authed(headers: Record<string, string> = {}): Request {
    return {
      user: { id: USER_ID },
      accessToken: 'jwt-de-prueba',
      headers,
    } as unknown as Request;
  }

  function signed(ts = String(Math.floor(Date.now() / 1000))): Request {
    const v1 = createHmac('sha256', SECRET)
      .update(buildManifest(DATA_ID, REQUEST_ID, ts))
      .digest('hex');
    return {
      headers: {
        'x-signature': `ts=${ts},v1=${v1}`,
        'x-request-id': REQUEST_ID,
      },
    } as unknown as Request;
  }

  const PAYMENT = {
    id: DATA_ID,
    status: 'approved',
    statusDetail: 'accredited',
    transactionAmount: 15000,
    currencyId: 'ARS',
    externalReference: 'spike-eng61-8e5b1153-1756900000000',
    paymentMethodId: 'visa',
    approvedAt: '2026-09-03T12:00:00.000-03:00',
  };

  beforeEach(() => {
    env = {
      MERCADOPAGO_WEBHOOK_SECRET: SECRET,
      MERCADOPAGO_NOTIFICATION_URL:
        'https://tunel.ngrok.app/payments/spike/webhooks/mercadopago',
    };

    mercadopago = {
      isConfigured: jest.fn().mockReturnValue(true),
      isSandbox: jest.fn().mockReturnValue(true),
      createPreference: jest.fn().mockResolvedValue({
        id: 'pref-1',
        initPoint: 'https://www.mercadopago.com.ar/checkout?pref_id=1',
        sandboxInitPoint:
          'https://sandbox.mercadopago.com.ar/checkout?pref_id=1',
        externalReference: 'spike-eng61-8e5b1153-1756900000000',
      }),
      getPayment: jest.fn().mockResolvedValue(PAYMENT),
    };

    const config = {
      get: (key: string) => env[key],
    } as unknown as ConfigService;
    controller = new PaymentsSpikeController(
      mercadopago as unknown as MercadoPagoService,
      config,
    );

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('createPreference', () => {
    it('marca la preferencia como del spike en el external_reference', async () => {
      await controller.createPreference(authed(), {});

      const [args] = mercadopago.createPreference.mock.calls[0];
      expect(args.externalReference).toMatch(
        new RegExp(`^${SPIKE_EXTERNAL_REFERENCE_PREFIX}-`),
      );
      // Idempotencia: un doble click no crea dos preferencias.
      expect(args.idempotencyKey).toBe(args.externalReference);
    });

    it('devuelve la URL de sandbox como la que hay que abrir', async () => {
      const result = await controller.createPreference(authed(), {});
      expect(result.abrirEsta).toBe(result.sandboxInitPoint);
    });

    // Sandbox y producción comparten host: sin este chequeo, un APP_USR- en el
    // .env convierte el spike en cobros reales.
    it('se niega a correr con credenciales productivas', async () => {
      mercadopago.isSandbox.mockReturnValue(false);

      await expect(
        controller.createPreference(authed(), {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });

    // Sin credenciales el service ya contesta el 503 explicado; el guard de
    // sandbox no debe adelantarse con un 403 que confunde el diagnóstico.
    it('deja pasar al service cuando no hay credenciales, para que tire el 503', async () => {
      mercadopago.isConfigured.mockReturnValue(false);
      mercadopago.isSandbox.mockReturnValue(false);

      await expect(
        controller.createPreference(authed(), {}),
      ).resolves.toBeDefined();
    });

    it('falla con el motivo si falta la URL pública de notificación', async () => {
      env.MERCADOPAGO_NOTIFICATION_URL = undefined;

      await expect(
        controller.createPreference(authed(), {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('webhook', () => {
    it('verifica la firma y vuelve a pedirle el pago a MercadoPago', async () => {
      const result = await controller.receiveWebhook(
        signed(),
        DATA_ID,
        undefined,
        {},
      );

      expect(result).toEqual({ verificada: true, pago: PAYMENT });
      // El estado sale de la API, no del body: la firma no cubre el cuerpo.
      expect(mercadopago.getPayment).toHaveBeenCalledWith(DATA_ID);
    });

    it('rechaza una firma inválida sin consultar a MercadoPago', async () => {
      const req = {
        headers: {
          'x-signature': 'ts=1,v1=deadbeef',
          'x-request-id': REQUEST_ID,
        },
      } as unknown as Request;

      await expect(
        controller.receiveWebhook(req, DATA_ID, undefined, {}),
      ).resolves.toEqual({ verificada: false, motivo: 'expired-timestamp' });
      expect(mercadopago.getPayment).not.toHaveBeenCalled();
    });

    // Contestar 401 le regala a un atacante los reintentos con backoff de
    // MercadoPago. El rechazo se registra, no se comunica por status.
    it('contesta sin excepción aunque la firma no valide', async () => {
      const req = { headers: {} } as unknown as Request;

      await expect(
        controller.receiveWebhook(req, DATA_ID, undefined, {}),
      ).resolves.toMatchObject({ verificada: false });
    });

    it('no procesa nada si falta el secreto de webhook', async () => {
      env.MERCADOPAGO_WEBHOOK_SECRET = undefined;

      await expect(
        controller.receiveWebhook(signed(), DATA_ID, undefined, {}),
      ).resolves.toEqual({
        verificada: false,
        motivo: 'sin-secreto-configurado',
      });
      expect(mercadopago.getPayment).not.toHaveBeenCalled();
    });

    it('acepta el id por el query viejo de IPN', async () => {
      await expect(
        controller.receiveWebhook(signed(), undefined, DATA_ID, {}),
      ).resolves.toMatchObject({ verificada: true });
    });

    it('cae al id del body cuando no viene por query', async () => {
      await expect(
        controller.receiveWebhook(signed(), undefined, undefined, {
          data: { id: DATA_ID },
        }),
      ).resolves.toMatchObject({ verificada: true });
    });

    // Un id inventado en el body no valida: entra en el manifest que se firma.
    it('rechaza un id del body que no coincide con la firma', async () => {
      await expect(
        controller.receiveWebhook(signed(), undefined, undefined, {
          data: { id: '999' },
        }),
      ).resolves.toEqual({ verificada: false, motivo: 'mismatch' });
    });
  });

  describe('getPayment', () => {
    it('se niega a consultar con credenciales productivas', () => {
      mercadopago.isSandbox.mockReturnValue(false);
      expect(() => controller.getPayment(DATA_ID)).toThrow(ForbiddenException);
    });
  });
});
