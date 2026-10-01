import { createHmac, timingSafeEqual } from 'node:crypto';
import { SIGNATURE_TOLERANCE_SECONDS } from './mercadopago.config';

/**
 * Verificación de la firma de los webhooks de MercadoPago (ENG-61, usada por ENG-64).
 *
 * Es una función pura y un archivo propio a propósito: el endpoint que la
 * consume es **público** (MercadoPago no manda un JWT nuestro, así que no puede
 * pasar por `JwtAuthGuard`), y entonces esta comparación es literalmente lo
 * único que separa un webhook de MercadoPago de un POST de cualquiera en
 * internet diciendo "el pago del turno tal está aprobado". Todo lo que decide
 * eso tiene que poder testearse sin levantar Nest ni tocar la red.
 *
 * ## El esquema, y por qué NO se firma el body
 *
 * MercadoPago no firma el cuerpo del request (a diferencia de Stripe). Firma un
 * **manifest** armado con tres datos que viajan fuera del body:
 *
 *     id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 *
 * donde `data.id` viene del query string, `x-request-id` de un header y `ts` del
 * propio header `x-signature`. La firma es `HMAC-SHA256(manifest, secret)` en
 * hexadecimal, y llega en `x-signature` como `ts=<unix>,v1=<hex>`.
 *
 * Que no firme el body tiene una consecuencia directa y es la razón por la que
 * ENG-64 no le cree nada al payload: la firma prueba que **MercadoPago mandó una
 * notificación sobre el pago `data.id`**, y nada más. El cuerpo podría venir
 * alterado sin romper la firma. Por eso el estado del pago se vuelve a pedir a
 * la API con el `id` verificado, en vez de leerlo del JSON que llegó.
 */

/** Resultado de verificar la firma. El motivo del rechazo se usa para loguear,
 *  nunca para responderle al emisor: decirle a un atacante si falló el formato,
 *  el HMAC o el reloj es ayudarlo a iterar. */
export type SignatureCheck =
  | { valid: true }
  | { valid: false; reason: SignatureFailure };

export type SignatureFailure =
  | 'missing-signature-header'
  | 'malformed-signature-header'
  | 'missing-request-id'
  | 'missing-data-id'
  | 'expired-timestamp'
  | 'mismatch';

export interface SignatureInput {
  /** Header `x-signature`, tal cual llegó: `ts=1704908010,v1=618c8534...`. */
  signatureHeader: string | undefined;
  /** Header `x-request-id`. Entra en el manifest. */
  requestId: string | undefined;
  /** Query param `data.id` (MercadoPago también lo manda como `id` a secas). */
  dataId: string | undefined;
  /** `MERCADOPAGO_WEBHOOK_SECRET`, la clave secreta del webhook en el panel. */
  secret: string;
  /** Inyectable para poder testear el vencimiento sin viajar en el tiempo. */
  now?: Date;
}

/**
 * Decide si una notificación viene realmente de MercadoPago.
 *
 * Chequea, en este orden: que el header exista y tenga las dos partes, que el
 * `ts` esté dentro de la ventana de tolerancia, y recién ahí el HMAC. El orden
 * importa poco para la seguridad y mucho para el costo: descarta lo barato antes
 * de calcular un digest.
 */
export function verifyWebhookSignature(input: SignatureInput): SignatureCheck {
  const { signatureHeader, requestId, dataId, secret } = input;

  if (!signatureHeader) {
    return { valid: false, reason: 'missing-signature-header' };
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return { valid: false, reason: 'malformed-signature-header' };
  }

  // Los tres componentes del manifest son obligatorios. MercadoPago documenta
  // que el segmento se omite si el valor no existe, pero en el webhook de pagos
  // los tres existen siempre: si falta alguno, o no es MercadoPago, o es una
  // notificación de otro tipo que este endpoint no debería estar procesando.
  if (!requestId) return { valid: false, reason: 'missing-request-id' };
  if (!dataId) return { valid: false, reason: 'missing-data-id' };

  if (isExpired(parsed.ts, input.now ?? new Date())) {
    return { valid: false, reason: 'expired-timestamp' };
  }

  const manifest = buildManifest(dataId, requestId, parsed.ts);
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');

  return equalsConstantTime(expected, parsed.v1)
    ? { valid: true }
    : { valid: false, reason: 'mismatch' };
}

/**
 * Arma el manifest exactamente como lo espera MercadoPago.
 *
 * El `toLowerCase()` del id no es cosmético: MercadoPago documenta que si el id
 * es alfanumérico tiene que ir en minúsculas para armar el manifest. Los ids de
 * pago son numéricos y no cambian, pero los de otros recursos (merchant orders,
 * suscripciones) sí, y esta función es la que va a reusar cualquier webhook que
 * se agregue después. Normalizar siempre cuesta nada y evita un fallo que solo
 * aparecería con el otro tipo de notificación.
 */
export function buildManifest(
  dataId: string,
  requestId: string,
  ts: string,
): string {
  return `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
}

/** Parsea `ts=...,v1=...`. Tolera espacios y orden invertido; no tolera que
 *  falte cualquiera de los dos, que es el caso que importa. */
function parseSignatureHeader(
  header: string,
): { ts: string; v1: string } | null {
  const parts = new Map<string, string>();

  for (const chunk of header.split(',')) {
    const separator = chunk.indexOf('=');
    if (separator === -1) continue;
    const key = chunk.slice(0, separator).trim();
    const value = chunk.slice(separator + 1).trim();
    if (key && value) parts.set(key, value);
  }

  const ts = parts.get('ts');
  const v1 = parts.get('v1');
  return ts && v1 ? { ts, v1 } : null;
}

/** `ts` fuera de la ventana de tolerancia, en cualquiera de los dos sentidos.
 *  Un `ts` del futuro también se rechaza: no hay razón legítima para que exista
 *  y aceptarlo permitiría fabricar una firma que no vence nunca. */
function isExpired(ts: string, now: Date): boolean {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return true;

  // MercadoPago manda el `ts` en segundos, pero hay integraciones donde llega en
  // milisegundos. Se detecta por magnitud en vez de asumir: un timestamp en
  // segundos posterior al año 2001 tiene 10 dígitos, y uno en milisegundos, 13.
  const millis = ts.length >= 13 ? seconds : seconds * 1000;
  const drift = Math.abs(now.getTime() - millis) / 1000;

  return drift > SIGNATURE_TOLERANCE_SECONDS;
}

/**
 * Compara dos digests sin filtrar por dónde difieren.
 *
 * Un `===` corta en el primer byte distinto, y esa diferencia de tiempo alcanza
 * para reconstruir la firma esperada byte a byte. `timingSafeEqual` exige que
 * los dos buffers midan lo mismo, así que la longitud se chequea antes —y esa
 * comparación sí puede ser directa: la longitud del digest es pública.
 */
function equalsConstantTime(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
