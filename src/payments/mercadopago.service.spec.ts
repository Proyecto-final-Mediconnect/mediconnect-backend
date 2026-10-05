import { ConfigService } from '@nestjs/config';
import {
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MercadoPagoApiError, MercadoPagoService } from './mercadopago.service';

/**
 * `MercadoPagoService` contra un `fetch` mockeado: se verifica el contrato que
 * el spike afirma (external_reference que vuelve, auto_return, idempotencia,
 * traducción de errores del proveedor) sin pegarle a MercadoPago ni depender de
 * la red en CI. Mismo molde que el spec de `DailyService`.
 */
describe('MercadoPagoService', () => {
  const TEST_TOKEN = 'TEST-1234567890';
  const APPOINTMENT_ID = 'a837eedd-09b2-413d-8a1a-ec0b7149803a';

  let service: MercadoPagoService;
  let fetchMock: jest.Mock;
  let env: Record<string, string | undefined>;

  function ok(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }

  function fail(status: number, detail = ''): Response {
    return {
      ok: false,
      status,
      text: () => Promise.resolve(detail),
    } as unknown as Response;
  }

  const PREFERENCE_BODY = {
    id: '123456789-abcd-ef01-2345-6789abcdef01',
    init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1',
    sandbox_init_point:
      'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=1',
    external_reference: APPOINTMENT_ID,
  };

  const PAYMENT_BODY = {
    id: 1234567890,
    status: 'approved',
    status_detail: 'accredited',
    transaction_amount: 15000,
    currency_id: 'ARS',
    external_reference: APPOINTMENT_ID,
    payment_method_id: 'visa',
    date_approved: '2026-09-03T12:00:00.000-03:00',
  };

  function createPreference(overrides = {}) {
    return service.createPreference({
      externalReference: APPOINTMENT_ID,
      notificationUrl:
        'https://api.mediconnect.ar/payments/webhooks/mercadopago',
      item: {
        title: 'Consulta médica',
        quantity: 1,
        unitPrice: 15000,
        currencyId: 'ARS',
      },
      backUrls: {
        success: 'https://mediconnect.ar/turnos/ok',
        failure: 'https://mediconnect.ar/turnos/error',
        pending: 'https://mediconnect.ar/turnos/pendiente',
      },
      ...overrides,
    });
  }

  /** Body JSON del enésimo `fetch`. */
  function bodyOf(call = 0): Record<string, unknown> {
    return JSON.parse(fetchMock.mock.calls[call][1].body as string) as Record<
      string,
      unknown
    >;
  }

  function headersOf(call = 0): Record<string, string> {
    return fetchMock.mock.calls[call][1].headers as Record<string, string>;
  }

  beforeEach(() => {
    env = { MERCADOPAGO_ACCESS_TOKEN: TEST_TOKEN };
    fetchMock = jest.fn();
    global.fetch = fetchMock;

    const config = {
      get: (key: string) => env[key],
      getOrThrow: (key: string) => {
        const value = env[key];
        if (value === undefined) throw new Error(`falta ${key}`);
        return value;
      },
    } as unknown as ConfigService;

    service = new MercadoPagoService(config);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('configuración', () => {
    it('se reporta configurado solo si hay access token', () => {
      expect(service.isConfigured()).toBe(true);
      env.MERCADOPAGO_ACCESS_TOKEN = undefined;
      expect(service.isConfigured()).toBe(false);
    });

    // Sandbox y producción comparten host: el token es lo único que los separa.
    it('distingue el token de prueba del productivo por su prefijo', () => {
      expect(service.isSandbox()).toBe(true);
      env.MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-1234567890';
      expect(service.isSandbox()).toBe(false);
    });

    it('contesta 503 explicado en vez de dejar que MercadoPago tire 401', async () => {
      env.MERCADOPAGO_ACCESS_TOKEN = undefined;

      await expect(createPreference()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('createPreference', () => {
    beforeEach(() => fetchMock.mockResolvedValue(ok(PREFERENCE_BODY)));

    it('devuelve el init_point y el external_reference que ata el pago al turno', async () => {
      const preference = await createPreference();

      expect(preference).toEqual({
        id: PREFERENCE_BODY.id,
        initPoint: PREFERENCE_BODY.init_point,
        sandboxInitPoint: PREFERENCE_BODY.sandbox_init_point,
        externalReference: APPOINTMENT_ID,
      });
    });

    // Sin external_reference, cuando llegue el webhook con un payment_id no hay
    // forma de saber qué turno confirmar.
    it('manda el external_reference y la notification_url', async () => {
      await createPreference();

      expect(bodyOf()).toMatchObject({
        external_reference: APPOINTMENT_ID,
        notification_url:
          'https://api.mediconnect.ar/payments/webhooks/mercadopago',
      });
    });

    it('pide auto_return solo para el pago aprobado', async () => {
      await createPreference();
      expect(bodyOf().auto_return).toBe('approved');
    });

    it('manda la clave de idempotencia cuando se le pasa', async () => {
      await createPreference({ idempotencyKey: `turno-${APPOINTMENT_ID}` });
      expect(headersOf()['X-Idempotency-Key']).toBe(`turno-${APPOINTMENT_ID}`);
    });

    it('no manda el header de idempotencia si no se le pasa clave', async () => {
      await createPreference();
      expect(headersOf()['X-Idempotency-Key']).toBeUndefined();
    });

    it('autentica con el access token como Bearer', async () => {
      await createPreference();
      expect(headersOf().Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    });

    it('conserva el external_reference pedido si MercadoPago no lo devuelve', async () => {
      fetchMock.mockResolvedValue(
        ok({ ...PREFERENCE_BODY, external_reference: undefined }),
      );

      await expect(createPreference()).resolves.toMatchObject({
        externalReference: APPOINTMENT_ID,
      });
    });
  });

  describe('getPayment', () => {
    it('normaliza la respuesta de MercadoPago', async () => {
      fetchMock.mockResolvedValue(ok(PAYMENT_BODY));

      await expect(service.getPayment('1234567890')).resolves.toEqual({
        id: '1234567890',
        status: 'approved',
        statusDetail: 'accredited',
        transactionAmount: 15000,
        currencyId: 'ARS',
        externalReference: APPOINTMENT_ID,
        paymentMethodId: 'visa',
        approvedAt: '2026-09-03T12:00:00.000-03:00',
      });
    });

    it('pide el pago por id a /v1/payments', async () => {
      fetchMock.mockResolvedValue(ok(PAYMENT_BODY));
      await service.getPayment('1234567890');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.mercadopago.com/v1/payments/1234567890',
      );
      expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    });

    it('escapa el id en la URL', async () => {
      fetchMock.mockResolvedValue(ok(PAYMENT_BODY));
      await service.getPayment('../v1/users/me');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.mercadopago.com/v1/payments/..%2Fv1%2Fusers%2Fme',
      );
    });

    it('deja en null los campos que MercadoPago omite mientras no está aprobado', async () => {
      fetchMock.mockResolvedValue(
        ok({
          ...PAYMENT_BODY,
          status: 'pending',
          date_approved: null,
          payment_method_id: null,
          external_reference: null,
        }),
      );

      await expect(service.getPayment('1234567890')).resolves.toMatchObject({
        status: 'pending',
        approvedAt: null,
        paymentMethodId: null,
        externalReference: null,
      });
    });

    it('apunta a MERCADOPAGO_API_URL cuando se declara un mock', async () => {
      env.MERCADOPAGO_API_URL = 'http://localhost:9999';
      fetchMock.mockResolvedValue(ok(PAYMENT_BODY));

      await service.getPayment('1234567890');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://localhost:9999/v1/payments/1234567890',
      );
    });
  });

  describe('errores del proveedor', () => {
    // Un 401 propagado tal cual haría que la web crea que venció la sesión del
    // usuario e intente renovarla en loop. El problema es de MercadoPago.
    it('traduce cualquier error de MercadoPago a 502', async () => {
      fetchMock.mockResolvedValue(fail(401, 'invalid access token'));

      await expect(service.getPayment('1')).rejects.toMatchObject({
        providerStatus: 401,
        status: HttpStatus.BAD_GATEWAY,
      });
    });

    // ENG-64 lo necesita para distinguir un data.id inexistente (webhook falso o
    // de otra cuenta) de una caída del proveedor.
    it('conserva el status del proveedor para poder distinguir un 404', async () => {
      fetchMock.mockResolvedValue(fail(404, 'payment not found'));

      await expect(service.getPayment('1')).rejects.toMatchObject({
        providerStatus: 404,
      });
    });

    it('traduce un timeout o fallo de red a 503 con providerStatus 0', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));

      await expect(service.getPayment('1')).rejects.toMatchObject({
        providerStatus: 0,
        status: HttpStatus.SERVICE_UNAVAILABLE,
      });
    });

    it('no filtra el detalle del proveedor en el mensaje al cliente', async () => {
      fetchMock.mockResolvedValue(fail(400, `token ${TEST_TOKEN} is invalid`));

      await expect(service.getPayment('1')).rejects.toThrow(
        /MercadoPago rechazó la operación \(HTTP 400\)/,
      );
      await expect(service.getPayment('1')).rejects.not.toThrow(
        new RegExp(TEST_TOKEN),
      );
    });

    it('un 2xx con un cuerpo que no es JSON es 502, no un 500 sin mensaje', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html>gateway</html>'),
      });

      await expect(service.getPayment('1')).rejects.toMatchObject({
        status: HttpStatus.BAD_GATEWAY,
        message: 'MercadoPago devolvió una respuesta que no pudimos leer.',
      });
    });

    it('es un MercadoPagoApiError, no un Error pelado', async () => {
      fetchMock.mockResolvedValue(fail(500));
      await expect(service.getPayment('1')).rejects.toBeInstanceOf(
        MercadoPagoApiError,
      );
    });
  });
});
