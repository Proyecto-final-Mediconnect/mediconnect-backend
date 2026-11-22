import { randomBytes } from 'node:crypto';
import {
  clinicalContentAt,
  DecryptionError,
  fieldAad,
  generateKeyEntry,
  isEncryptedJson,
  open,
  openJson,
  parseKeyring,
  seal,
  sealJson,
} from './data-encryption';

const key = () => randomBytes(32).toString('base64');
const PATIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_PATIENT = '22222222-2222-4222-8222-222222222222';
const CONTENT = {
  resourceType: 'ClinicalImpression',
  summary: 'Enalapril 10 mg cada 12 horas. No es alérgica a la penicilina.',
};

/** ENG-216 — el núcleo del cifrado de sobre, en memoria. */
describe('data-encryption', () => {
  describe('parseKeyring (DATA_ENCRYPTION_KEYS)', () => {
    it('sin la variable, o vacía, el cifrado queda apagado', () => {
      expect(parseKeyring(undefined)).toBeNull();
      expect(parseKeyring('')).toBeNull();
      expect(parseKeyring('   ')).toBeNull();
    });

    it('lee varias claves y la activa es la última', () => {
      const ring = parseKeyring(`k1:${key()},k2:${key()}`)!;
      expect([...ring.keys.keys()]).toEqual(['k1', 'k2']);
      expect(ring.activeKid).toBe('k2');
      expect(ring.keys.get('k1')).toHaveLength(32);
    });

    it.each([
      ['sin kid', `:${key()}`],
      ['kid con mayúsculas', `K1:${key()}`],
      ['sin separador', key()],
      ['clave corta', `k1:${randomBytes(16).toString('base64')}`],
      ['no es base64', 'k1:esto-no-es-una-clave'],
    ])('falla si está mal formada: %s', (_caso, raw) => {
      expect(() => parseKeyring(raw)).toThrow(/DATA_ENCRYPTION_KEYS/);
    });

    it('falla con un kid repetido o con la misma clave dos veces', () => {
      const k = key();
      expect(() => parseKeyring(`k1:${k},k1:${key()}`)).toThrow(/repetido/);
      expect(() => parseKeyring(`k1:${k},k2:${k}`)).toThrow(/misma clave/);
    });

    it('el mensaje de error nunca repite el valor de la clave', () => {
      const corta = randomBytes(16).toString('base64');
      try {
        parseKeyring(`k1:${corta}`);
        throw new Error('debía fallar');
      } catch (error) {
        expect((error as Error).message).not.toContain(corta);
      }
    });

    it('generateKeyEntry arma una línea que parseKeyring acepta', () => {
      const ring = parseKeyring(generateKeyEntry('k3'))!;
      expect(ring.activeKid).toBe('k3');
      expect(() => generateKeyEntry('K3')).toThrow();
    });
  });

  describe('seal / open', () => {
    const k = randomBytes(32);
    const aad = fieldAad(PATIENT, clinicalContentAt('e1'));

    it('descifra lo que cifró, y el mismo texto cifrado dos veces da valores distintos', () => {
      const a = seal(k, Buffer.from('hola'), aad);
      const b = seal(k, Buffer.from('hola'), aad);
      expect(a).not.toBe(b);
      expect(open(k, a, aad).toString()).toBe('hola');
    });

    it('un byte cambiado no descifra', () => {
      const [nonce, tag, texto] = seal(k, Buffer.from('hola'), aad).split('.');
      const alterado = Buffer.from(texto, 'base64url');
      alterado[0] ^= 1;
      expect(() =>
        open(k, [nonce, tag, alterado.toString('base64url')].join('.'), aad),
      ).toThrow(DecryptionError);
    });

    it('con otra clave o en otro lugar no descifra', () => {
      const token = seal(k, Buffer.from('hola'), aad);
      expect(() => open(randomBytes(32), token, aad)).toThrow(DecryptionError);
      expect(() =>
        open(k, token, fieldAad(PATIENT, clinicalContentAt('e2'))),
      ).toThrow(DecryptionError);
      expect(() =>
        open(k, token, fieldAad(OTHER_PATIENT, clinicalContentAt('e1'))),
      ).toThrow(DecryptionError);
    });

    it('un formato roto falla con DecryptionError y no con otro error', () => {
      expect(() => open(k, 'abc', aad)).toThrow(DecryptionError);
      expect(() => open(k, 'a.b.c', aad)).toThrow(DecryptionError);
    });

    it('el AAD no distingue mayúsculas en los UUID (como Postgres)', () => {
      expect(fieldAad(PATIENT.toUpperCase(), clinicalContentAt('E1'))).toBe(
        aad,
      );
    });
  });

  describe('JSON cifrado', () => {
    const k = randomBytes(32);
    const aad = fieldAad(PATIENT, clinicalContentAt('e1'));

    it('se guarda con la marca $enc, sin el texto a la vista, y vuelve igual', () => {
      const stored = sealJson(k, CONTENT, aad);
      expect(Object.keys(stored)).toEqual(['$enc']);
      expect(stored.$enc.startsWith('v1.')).toBe(true);
      expect(JSON.stringify(stored)).not.toContain('Enalapril');
      expect(openJson(k, stored, aad)).toEqual(CONTENT);
    });

    it('reconoce solo la marca exacta: un recurso FHIR en claro no es cifrado', () => {
      expect(isEncryptedJson(sealJson(k, CONTENT, aad))).toBe(true);
      expect(isEncryptedJson(CONTENT)).toBe(false);
      expect(isEncryptedJson({ $enc: 'x', otra: 1 })).toBe(false);
      expect(isEncryptedJson({ $enc: 1 })).toBe(false);
      expect(isEncryptedJson(['$enc'])).toBe(false);
      expect(isEncryptedJson(null)).toBe(false);
      expect(isEncryptedJson('v1.a.b.c')).toBe(false);
    });

    it('una versión desconocida no se descifra', () => {
      const stored = sealJson(k, CONTENT, aad);
      expect(() =>
        openJson(k, { $enc: stored.$enc.replace(/^v1\./, 'v9.') }, aad),
      ).toThrow(DecryptionError);
    });
  });
});
