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
    expect(verify()).toEqual({ valid: true, ageSeconds: 0 });
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
      ageSeconds: 0,
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
        ageSeconds: SIGNATURE_TOLERANCE_SECONDS - 1,
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

    it('rechaza un ts que no es un número, aun sin ventana', () => {
      // Un ts así no lo firma MercadoPago: es un header mal formado, no viejo.
      for (const toleranceSeconds of [undefined, null]) {
        expect(
          verify({ signatureHeader: 'ts=ayer,v1=deadbeef', toleranceSeconds }),
        ).toEqual({ valid: false, reason: 'malformed-signature-header' });
      }
    });

    // El webhook productivo (ENG-64) no exige ventana: los reintentos de
    // MercadoPago llegan 15 minutos o más después.
    it('con toleranceSeconds null acepta una firma vieja e informa su edad', () => {
      const dayAgo = 24 * 60 * 60;
      expect(verify({ ...atOffset(-dayAgo), toleranceSeconds: null })).toEqual({
        valid: true,
        ageSeconds: dayAgo,
      });
    });

    it('con toleranceSeconds null el HMAC se sigue exigiendo', () => {
      const ts = String(Math.floor(NOW.getTime() / 1000) - 3600);
      expect(
        verify({
          signatureHeader: header(ts, '0'.repeat(64)),
          toleranceSeconds: null,
        }),
      ).toEqual({ valid: false, reason: 'mismatch' });
    });

    it('interpreta un ts en milisegundos por su magnitud', () => {
      const ts = String(NOW.getTime());
      expect(verify({ signatureHeader: header(ts, sign(ts)) })).toEqual({
        valid: true,
        ageSeconds: 0,
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
