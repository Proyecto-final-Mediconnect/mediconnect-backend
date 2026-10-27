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
  /** Hasta cuándo se puede pagar. `null` si la preferencia no vence, que con
   *  las que crea este service no debería pasar nunca. */
  expiresAt: Date | null;
  /** Adónde vuelve el navegador al aprobarse el pago. Sirve para saber si una
   *  preferencia que se va a reutilizar vuelve a la web o a la app (ENG-172). */
  backUrlSuccess: string | null;
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

/** Reembolso tal como lo reporta MercadoPago (ENG-65). */
export interface MercadoPagoRefund {
  id: string;
  /** `approved`, `in_process`, `rejected`, `cancelled`, ... */
  status: string;
  amount: number;
}

/** Respuesta de `POST /v1/payments/:id/refunds`. Solo se tipa lo que se usa. */
interface RefundResponse {
  id: number | string;
  status: string;
  amount: number;
}

/** Respuesta de `POST`/`GET /checkout/preferences`. Solo se tipa lo que se usa. */
interface PreferenceResponse {
  id: string;
  init_point: string;
  sandbox_init_point: string;
  external_reference?: string;
  expires?: boolean;
  expiration_date_to?: string | null;
  back_urls?: { success?: string };
}

/**
 * Tipos de medio de pago que no se ofrecen: `ticket` (Rapipago, Pago Fácil) y
 * `atm` (cajero, Red Link). Los dos quedan `pending` y se acreditan días
 * después, cuando el turno ya pasó o el horario ya lo tomó otra persona: se
 * cobraría algo que no se puede confirmar. Un turno se paga en el momento o no
 * se paga.
 */
const EXCLUDED_PAYMENT_TYPES = ['ticket', 'atm'];

/**
 * Fecha en el formato que pide MercadoPago para `expiration_date_to`
 * (`yyyy-MM-dd'T'HH:mm:ss.SSSZ`, p. ej. `2026-10-14T12:00:00.000-03:00`).
 *
 * Se manda con el offset de Argentina explícito en vez del `Z` de
 * `toISOString()`: es lo que muestran todos los ejemplos de la documentación, y
 * Argentina no tiene horario de verano, así que `-03:00` es fijo.
 */
export function toMercadoPagoDate(date: Date): string {
  const local = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  return local.toISOString().replace('Z', '-03:00');
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

  /**
   * `true` si se está operando contra el entorno de prueba.
   *
   * Lo usa ENG-63 para dos cosas distintas: a qué `init_point` mandar al pagador y si
   * avisarle en pantalla que el cobro no es real.
   *
   * **Se puede forzar con `MERCADOPAGO_SANDBOX` y por eso existe esa variable.**
   * Inferirlo del prefijo del token alcanza mientras las credenciales de prueba
   * sean `TEST-`, pero las de un *usuario de prueba* creado con el endpoint de
   * test users son `APP_USR-` igual que las productivas: ahí el prefijo deja de
   * distinguir nada y el flag miente, sin que nadie se entere hasta que alguien
   * mira un checkout que no debería poder completarse.
   *
   * No se cambió la regla del prefijo —que `APP_USR-` pase a significar sandbox
   * rompería las credenciales productivas de verdad, y cuál de los dos
   * `init_point` corresponde a un usuario de prueba no está documentado— sino
   * que se agregó la forma de decirlo explícitamente. Una variable en Render
   * resuelve el caso sin tocar código ni apostar a una inferencia.
   */
  isSandbox(): boolean {
    const explicito = this.config.get<string>('MERCADOPAGO_SANDBOX');
    if (explicito !== undefined && explicito !== '') {
      return explicito === 'true';
    }

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
   *
   * La preferencia **siempre vence** (`expiresAt`) y es **binaria**: el pago se
   * aprueba o se rechaza en el momento, sin quedar pendiente. Sin las dos cosas,
   * un link viejo —o un pago en efectivo que se acredita días después— cobra un
   * turno que ya no se puede confirmar, y no hay reembolso automático.
   */
  async createPreference(params: {
    externalReference: string;
    notificationUrl: string;
    item: PreferenceItem;
    /** URLs de vuelta al front después de pagar. */
    backUrls: { success: string; failure: string; pending: string };
    /** Desde cuándo MercadoPago deja de aceptar pagos de esta preferencia. */
    expiresAt: Date;
    /** Clave de idempotencia. Red de seguridad para dos requests simultáneos:
     *  la defensa principal contra preferencias duplicadas es reutilizar la
     *  guardada (ver `AppointmentPaymentService`). */
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
        expires: true,
        expiration_date_to: toMercadoPagoDate(params.expiresAt),
        // Sin estados intermedios: lo que no se aprueba en el momento se
        // rechaza, y el turno no queda esperando una acreditación que puede
        // llegar cuando ya no sirve.
        binary_mode: true,
        payment_methods: {
          excluded_payment_types: EXCLUDED_PAYMENT_TYPES.map((id) => ({ id })),
        },
      },
      params.idempotencyKey,
    );

    return this.toPreference(body, params.externalReference);
  }

  /**
   * Preferencia ya creada, para poder reutilizarla en vez de crear otra.
   *
   * Una preferencia nueva por cada click deja vivas las anteriores, y cualquiera
   * de ellas se puede pagar desde una pestaña que quedó abierta.
   */
  async getPreference(preferenceId: string): Promise<Preference> {
    this.assertConfigured();

    const body = await this.request<PreferenceResponse>(
      'GET',
      `/checkout/preferences/${encodeURIComponent(preferenceId)}`,
    );

    return this.toPreference(body, body.external_reference ?? '');
  }

  /**
   * Cambia adónde vuelve el navegador después de pagar (ENG-172).
   *
   * Se usa cuando un turno que ya tiene preferencia se paga desde la otra punta
   * —empezó en la web y sigue en la app, o al revés—. Crear otra dejaría viva la
   * anterior y el turno tendría dos links pagables; actualizar la misma no.
   * MercadoPago conserva el `auto_return` y el vencimiento.
   */
  async updateBackUrls(
    preferenceId: string,
    backUrls: { success: string; failure: string; pending: string },
  ): Promise<void> {
    this.assertConfigured();

    await this.request(
      'PUT',
      `/checkout/preferences/${encodeURIComponent(preferenceId)}`,
      { back_urls: backUrls },
    );
  }

  /**
   * Vence una preferencia ya: después de esto MercadoPago no acepta pagos con
   * ella. Se usa al cancelar el turno, para que el link que el paciente dejó
   * abierto no cobre un turno que ya no existe.
   */
  async expirePreference(preferenceId: string, now: Date): Promise<void> {
    this.assertConfigured();

    await this.request(
      'PUT',
      `/checkout/preferences/${encodeURIComponent(preferenceId)}`,
      { expires: true, expiration_date_to: toMercadoPagoDate(now) },
    );
  }

  private toPreference(
    body: PreferenceResponse,
    externalReference: string,
  ): Preference {
    return {
      id: body.id,
      initPoint: body.init_point,
      sandboxInitPoint: body.sandbox_init_point,
      externalReference: body.external_reference ?? externalReference,
      expiresAt:
        body.expires && body.expiration_date_to
          ? new Date(body.expiration_date_to)
          : null,
      backUrlSuccess: body.back_urls?.success || null,
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

  /**
   * Devuelve `amount` de un pago aprobado (ENG-65). Con un monto menor al
   * cobrado, MercadoPago hace un reembolso parcial; el pago sigue `approved`
   * hasta que se devuelve todo, y ahí pasa a `refunded`.
   *
   * La clave de idempotencia es obligatoria y no opcional como en las
   * preferencias: un reintento después de un timeout que sí llegó a
   * MercadoPago devolvería la plata dos veces.
   */
  async refundPayment(
    paymentId: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<MercadoPagoRefund> {
    this.assertConfigured();

    const body = await this.request<RefundResponse>(
      'POST',
      `/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
      { amount },
      idempotencyKey,
    );

    return { id: String(body.id), status: body.status, amount: body.amount };
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'La integración con MercadoPago no está configurada en este entorno (falta MERCADOPAGO_ACCESS_TOKEN).',
      );
    }
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT',
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
