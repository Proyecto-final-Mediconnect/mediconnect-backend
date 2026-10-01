/**
 * Constantes de la integración con MercadoPago (ADR-013).
 *
 * Separado del service por el mismo motivo que `daily.config.ts` en ENG-51: son
 * los números y las decisiones del proveedor, y se leen sin tener que entrar al
 * cliente HTTP.
 */

/** API de MercadoPago. Es la MISMA URL para sandbox y para producción: lo que
 *  separa los dos entornos es el access token, no el host. Es la trampa número
 *  uno de esta integración —no hay un `sandbox.mercadopago.com` al que apuntar—
 *  y por eso el token de prueba y el de producción no pueden convivir en el
 *  mismo `.env` sin que alguien cobre de verdad sin querer. */
export const MERCADOPAGO_API_URL = 'https://api.mercadopago.com';

/** Cuánto se espera a MercadoPago antes de cortar. Mismo criterio que Daily: sin
 *  timeout, un incidente del proveedor deja requests colgados ocupando
 *  conexiones del backend. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Ventana de tolerancia del timestamp de la firma, en segundos.
 *
 * La firma de MercadoPago incluye un `ts` y ese `ts` entra en el manifest, así
 * que no se puede alterar sin invalidar la firma. Pero una firma vieja sigue
 * siendo válida para siempre si nadie mira el reloj: quien capture un webhook
 * legítimo puede reenviarlo mañana y el backend volvería a procesarlo. La
 * idempotencia de ENG-64 lo frena igual, pero eso es la segunda línea; esta es
 * la primera y no depende del estado de la base.
 *
 * Cinco minutos es holgado a propósito: MercadoPago reintenta los webhooks que
 * no contestan 2xx, y un reintento tardío no debería morir por unos segundos de
 * desfasaje de reloj entre su infra y la nuestra.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Estados de un pago en MercadoPago que se consideran finales y aprobados.
 *
 * `approved` es el único que confirma un turno. `authorized` NO entra: es una
 * retención de fondos sin captura (tarjeta autorizada pero no cobrada), y
 * confirmar un turno contra una autorización sin capturar significaría dar el
 * servicio sin haber cobrado. Si algún día se usa el flujo de dos pasos, esto
 * cambia junto con la lógica de captura, no antes.
 */
export const APPROVED_STATUS = 'approved';

/**
 * Estados de un pago en MercadoPago que cierran el intento sin plata.
 *
 * Se agrupan porque para el dominio son lo mismo —el turno no se confirma— pero
 * se guardan por separado en `payments.status` para poder contestarle distinto
 * al paciente: `rejected` se puede reintentar con otra tarjeta, `cancelled` y
 * `refunded` no.
 */
export const FAILED_STATUSES = [
  'rejected',
  'cancelled',
  'refunded',
  'charged_back',
] as const;
