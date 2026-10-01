import { createHmac } from 'node:crypto';
import { buildManifest, verifyWebhookSignature } from './mercadopago-signature';
import { SIGNATURE_TOLERANCE_SECONDS } from './mercadopago.config';

/**
 * Tests de la única barrera del endpoint público de webhooks (ENG-61/ENG-64).
 *
 * Se testea la función pura y no el controller a propósito: acá viven los casos
 * que deciden si un POST anónimo confirma un turno, y quedan legibles sin el
 * ruido de levantar Nest. El camino HTTP completo lo cubre el spec de
 * integración de ENG-64.
 */

const SECRET = 'clave-de-webhook-de-prueba';
const DATA_ID = '1234567890';
const REQUEST_ID = 'e7b8f0a2-0000-4000-8000-abcdef123456';
const NOW = new Date('2026-09-03T12:00:00.000Z');

/** Firma un manifest como lo haría MercadoPago. */
function sign(ts: string, dataId = DATA_ID, requestId = REQUEST_ID): string {
  return createHmac('sha256', SECRET)
    .update(buildManifest(dataId, requestId, ts))
    .digest('hex');
}

/** `ts` válido: el instante de `NOW` en segundos. */
const TS = String(Math.floor(NOW.getTime() / 1000));

function header(ts = TS, v1 = sign(ts)): string {
  return `ts=${ts},v1=${v1}`;
}

function verify(
  overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {},
) {
  return verifyWebhookSignature({
    signatureHeader: header(),
    requestId: REQUEST_ID,
    dataId: DATA_ID,
    secret: SECRET,
    now: NOW,
    ...overrides,
  });
}

describe('verifyWebhookSignature', () => {
  it('acepta una notificación firmada con el secreto correcto', () => {
    expect(verify()).toEqual({ valid: true });
  });

  it('rechaza una firma calculada con otro secreto', () => {
    const otra = createHmac('sha256', 'secreto-de-un-atacante')
      .update(buildManifest(DATA_ID, REQUEST_ID, TS))
      .digest('hex');

    expect(verify({ signatureHeader: header(TS, otra) })).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  // El caso que justifica todo el archivo: sin verificación, este POST confirma
  // un turno que nadie pagó.
  it('rechaza una notificación sin header de firma', () => {
    expect(verify({ signatureHeader: undefined })).toEqual({
      valid: false,
      reason: 'missing-signature-header',
    });
  });

  it('rechaza un header que no trae las dos partes', () => {
    expect(verify({ signatureHeader: `ts=${TS}` })).toEqual({
      valid: false,
      reason: 'malformed-signature-header',
    });
    expect(verify({ signatureHeader: 'no-tiene-formato' })).toEqual({
      valid: false,
      reason: 'malformed-signature-header',
    });
  });

  it('tolera espacios y el orden invertido de ts y v1', () => {
    expect(verify({ signatureHeader: ` v1=${sign(TS)} , ts=${TS} ` })).toEqual({
      valid: true,
    });
  });

  // La firma es sobre el manifest, así que cambiar el id invalida la firma
  // aunque el header llegue intacto: es lo que impide reapuntar una
  // notificación legítima a otro pago.
  it('rechaza una firma válida reapuntada a otro data.id', () => {
    expect(verify({ dataId: '9999999999' })).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('rechaza una firma válida reapuntada a otro request-id', () => {
    expect(verify({ requestId: 'otro-request-id' })).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('exige request-id y data.id para poder armar el manifest', () => {
    expect(verify({ requestId: undefined })).toEqual({
      valid: false,
      reason: 'missing-request-id',
    });
    expect(verify({ dataId: undefined })).toEqual({
      valid: false,
      reason: 'missing-data-id',
    });
  });

  describe('ventana de tolerancia del timestamp', () => {
    /** `ts` desplazado `offset` segundos respecto de NOW, con su firma. */
    function atOffset(offset: number) {
      const ts = String(Math.floor(NOW.getTime() / 1000) + offset);
      return { signatureHeader: header(ts, sign(ts)) };
    }

    it('acepta un ts dentro de la ventana', () => {
      expect(verify(atOffset(-(SIGNATURE_TOLERANCE_SECONDS - 1)))).toEqual({
        valid: true,
      });
    });

    // Replay: una firma capturada sigue siendo criptográficamente válida para
    // siempre. Lo que la vence es el reloj, no el HMAC.
    it('rechaza un ts anterior a la ventana', () => {
      expect(verify(atOffset(-(SIGNATURE_TOLERANCE_SECONDS + 60)))).toEqual({
        valid: false,
        reason: 'expired-timestamp',
      });
    });

    it('rechaza un ts del futuro', () => {
      expect(verify(atOffset(SIGNATURE_TOLERANCE_SECONDS + 60))).toEqual({
        valid: false,
        reason: 'expired-timestamp',
      });
    });

    it('rechaza un ts que no es un número', () => {
      expect(verify({ signatureHeader: 'ts=ayer,v1=deadbeef' })).toEqual({
        valid: false,
        reason: 'expired-timestamp',
      });
    });

    it('interpreta un ts en milisegundos por su magnitud', () => {
      const ts = String(NOW.getTime());
      expect(verify({ signatureHeader: header(ts, sign(ts)) })).toEqual({
        valid: true,
      });
    });
  });
});

describe('buildManifest', () => {
  it('respeta el formato exacto que espera MercadoPago', () => {
    expect(buildManifest('123', 'req-1', '1700000000')).toBe(
      'id:123;request-id:req-1;ts:1700000000;',
    );
  });

  // Documentado por MercadoPago para los ids alfanuméricos. Los de pago son
  // numéricos, pero esta función la va a reusar cualquier otro webhook.
  it('pasa a minúsculas un id alfanumérico', () => {
    expect(buildManifest('AbC123', 'req-1', '1700000000')).toBe(
      'id:abc123;request-id:req-1;ts:1700000000;',
    );
  });
});
