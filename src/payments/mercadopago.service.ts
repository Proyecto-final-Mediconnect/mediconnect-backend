import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MERCADOPAGO_API_URL, REQUEST_TIMEOUT_MS } from './mercadopago.config';

/**
 * Cliente de la API REST de MercadoPago (ENG-61, ADR-013).
 *
 * Wrapper fino sobre `fetch`, por la misma razón que `DailyService`: el SDK
 * oficial (`mercadopago`) arrastra su propia capa de configuración y de tipos
 * para envolver tres endpoints que son HTTP plano, y Node 22+ ya trae `fetch`.
 * Una dependencia menos en un módulo que toca plata es una superficie menos que
 * auditar.
 *
 * ## Sandbox y producción comparten host
 *
 * No hay un dominio de pruebas: `api.mercadopago.com` es el mismo para los dos
 * entornos y lo único que los separa es el access token (`TEST-...` contra
 * `APP_USR-...`). Es la trampa principal de la integración y está anotada en el
 * informe del spike: con el token equivocado en el `.env` se cobra de verdad.
 * `MERCADOPAGO_API_URL` existe solo para apuntar a un mock en pruebas manuales,
 * igual que `DAILY_API_URL`.
 */

/** Ítem de una preferencia. MercadoPago exige título, cantidad y precio. */
export interface PreferenceItem {
  title: string;
  quantity: number;
  unitPrice: number;
  currencyId: string;
}

/** Preferencia creada: es el "carrito" al que se manda al pagador. */
export interface Preference {
  id: string;
  /** URL del Checkout Pro de producción. */
  initPoint: string;
  /** URL del Checkout Pro con las credenciales de prueba. */
  sandboxInitPoint: string;
  /** Lo que se mandó como `external_reference`: es el hilo que ata el pago con
   *  el turno cuando vuelve el webhook. */
  externalReference: string;
}

/**
 * Pago tal como lo reporta MercadoPago.
 *
 * Es la **fuente de verdad** del estado, y por eso ENG-64 lo vuelve a pedir en
 * vez de leer el body del webhook: la firma de MercadoPago cubre el manifest
 * (id + request-id + ts), no el cuerpo del request. Ver
 * `mercadopago-signature.ts`.
 */
export interface MercadoPagoPayment {
  id: string;
  /** `approved`, `pending`, `rejected`, `cancelled`, `refunded`, ... */
  status: string;
  /** Detalle del estado: distingue "fondos insuficientes" de "tarjeta robada". */
  statusDetail: string;
  transactionAmount: number;
  currencyId: string;
  /** El id del turno que puso quien creó la preferencia. `null` si la
   *  preferencia se creó sin él, que es un error de programación del lado
   *  nuestro y ENG-64 lo trata como tal. */
  externalReference: string | null;
  /** Medio de pago concreto (`visa`, `master`, `account_money`, ...). */
  paymentMethodId: string | null;
  /** Momento de la aprobación, ISO-8601. `null` mientras no esté aprobado. */
  approvedAt: string | null;
}

/** Respuesta de `POST /checkout/preferences`. Solo se tipa lo que se usa. */
interface PreferenceResponse {
  id: string;
  init_point: string;
  sandbox_init_point: string;
  external_reference?: string;
}

/** Respuesta de `GET /v1/payments/:id`. Solo se tipa lo que se usa. */
interface PaymentResponse {
  id: number | string;
  status: string;
  status_detail?: string;
  transaction_amount: number;
  currency_id: string;
  external_reference?: string | null;
  payment_method_id?: string | null;
  date_approved?: string | null;
}

@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * `MERCADOPAGO_ACCESS_TOKEN` es opcional en la validación de entorno —el
   * backend tiene que bootear en CI y en local sin credenciales de terceros—,
   * así que la ausencia se detecta acá y sale como un 503 explicado en vez de un
   * 401 de MercadoPago. Mismo criterio que `DailyService.isConfigured`.
   */
  isConfigured(): boolean {
    return Boolean(this.config.get<string>('MERCADOPAGO_ACCESS_TOKEN'));
  }

  /** `true` si el token configurado es de prueba (prefijo `TEST-`). */
  isSandbox(): boolean {
    return (
      this.config
        .get<string>('MERCADOPAGO_ACCESS_TOKEN')
        ?.startsWith('TEST-') ?? false
    );
  }

  /**
   * Crea una preferencia de Checkout Pro y devuelve las URLs para pagarla.
   *
   * `externalReference` es el dato que hace que todo esto funcione: MercadoPago
   * lo devuelve intacto en el pago, y es lo único que ata la notificación con el
   * turno. Sin él, cuando llega el webhook con un `payment_id` no hay forma de
   * saber qué turno confirmar.
   *
   * `notificationUrl` es adónde MercadoPago va a mandar el webhook de ENG-64.
   * Tiene que ser pública y HTTPS: en local no alcanza con `localhost`, hace
   * falta un túnel (ver el informe del spike).
   */
  async createPreference(params: {
    externalReference: string;
    notificationUrl: string;
    item: PreferenceItem;
    /** URLs de vuelta al front después de pagar. */
    backUrls: { success: string; failure: string; pending: string };
    /** Clave de idempotencia. Dos llamadas con la misma clave devuelven la misma
     *  preferencia en vez de crear dos: evita cobrar dos veces el mismo turno si
     *  el paciente hace doble click o el front reintenta. */
    idempotencyKey?: string;
  }): Promise<Preference> {
    this.assertConfigured();

    const body = await this.request<PreferenceResponse>(
      'POST',
      '/checkout/preferences',
      {
        external_reference: params.externalReference,
        notification_url: params.notificationUrl,
        items: [
          {
            title: params.item.title,
            quantity: params.item.quantity,
            unit_price: params.item.unitPrice,
            currency_id: params.item.currencyId,
          },
        ],
        back_urls: params.backUrls,
        // Vuelve solo al front cuando el pago se aprueba. No se usa como señal
        // de confirmación: el back_url lo dispara el navegador del pagador y es
        // trivial de falsificar. Quien confirma es el webhook (ENG-64).
        auto_return: 'approved',
      },
      params.idempotencyKey,
    );

    return {
      id: body.id,
      initPoint: body.init_point,
      sandboxInitPoint: body.sandbox_init_point,
      externalReference: body.external_reference ?? params.externalReference,
    };
  }

  /**
   * Estado real de un pago, pedido a MercadoPago.
   *
   * Es el corazón de ENG-64. El webhook trae un `data.id` firmado y **nada más
   * que sea confiable**: el body no entra en la firma. Así que el flujo es
   * siempre verificar la firma, quedarse con el id, y volver a preguntar acá.
   */
  async getPayment(paymentId: string): Promise<MercadoPagoPayment> {
    this.assertConfigured();

    const body = await this.request<PaymentResponse>(
      'GET',
      `/v1/payments/${encodeURIComponent(paymentId)}`,
    );

    return {
      id: String(body.id),
      status: body.status,
      statusDetail: body.status_detail ?? '',
      transactionAmount: body.transaction_amount,
      currencyId: body.currency_id,
      externalReference: body.external_reference ?? null,
      paymentMethodId: body.payment_method_id ?? null,
      approvedAt: body.date_approved ?? null,
    };
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'La integración con MercadoPago no está configurada en este entorno (falta MERCADOPAGO_ACCESS_TOKEN).',
      );
    }
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const accessToken = this.config.getOrThrow<string>(
      'MERCADOPAGO_ACCESS_TOKEN',
    );
    const baseUrl =
      this.config.get<string>('MERCADOPAGO_API_URL') ?? MERCADOPAGO_API_URL;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(idempotencyKey !== undefined && {
            'X-Idempotency-Key': idempotencyKey,
          }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // Timeout o fallo de red. El `cause` no se propaga al cliente: puede traer
      // la URL interna y al usuario no le dice nada.
      this.logger.error(
        `MercadoPago ${method} ${path} falló: ${String(cause)}`,
      );
      throw new MercadoPagoApiError(
        0,
        HttpStatus.SERVICE_UNAVAILABLE,
        'No pudimos comunicarnos con MercadoPago. Probá de nuevo en unos minutos.',
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // El detalle va al log y no a la respuesta: los errores de MercadoPago
      // citan el access token en algunos casos.
      this.logger.error(
        `MercadoPago ${method} ${path} devolvió ${response.status}: ${detail.slice(0, 300)}`,
      );
      throw new MercadoPagoApiError(
        response.status,
        // Siempre 502, nunca el status del proveedor tal cual: un 401 de
        // MercadoPago (token vencido) propagado como 401 haría que la web crea
        // que venció la sesión del usuario. El problema es del proveedor.
        HttpStatus.BAD_GATEWAY,
        `MercadoPago rechazó la operación (HTTP ${response.status}).`,
      );
    }

    const text = await response.text();
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      // Un 2xx con un cuerpo que no es JSON es un fallo del proveedor, y se
      // trata como tal: 502 explicado en vez de un 500 sin mensaje.
      this.logger.error(
        `MercadoPago ${method} ${path} devolvió un cuerpo que no es JSON: ${text.slice(0, 300)}`,
      );
      throw new MercadoPagoApiError(
        response.status,
        HttpStatus.BAD_GATEWAY,
        'MercadoPago devolvió una respuesta que no pudimos leer.',
      );
    }
  }
}

/**
 * Fallo hablando con MercadoPago.
 *
 * `HttpException` para que Nest la serialice sola, y guarda aparte el status del
 * proveedor para poder distinguir un 404 esperado (un `data.id` que no existe:
 * webhook falso o de otra cuenta) de un fallo real. `providerStatus` en 0
 * significa que no hubo respuesta: timeout o error de red.
 */
export class MercadoPagoApiError extends HttpException {
  constructor(
    readonly providerStatus: number,
    exposedStatus: HttpStatus,
    message: string,
  ) {
    super(message, exposedStatus);
    this.name = 'MercadoPagoApiError';
  }
}
