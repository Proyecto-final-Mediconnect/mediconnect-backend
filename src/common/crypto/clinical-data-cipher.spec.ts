import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import { ClinicalDataCipher, type FileTicket } from './clinical-data-cipher';
import {
  clinicalContentAt,
  DecryptionError,
  MissingKeyError,
  parseKeyring,
  storedFileAt,
  type Keyring,
} from './data-encryption';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_PATIENT = '22222222-2222-4222-8222-222222222222';
const CONTENT = { resourceType: 'ClinicalImpression', summary: 'Control' };
const AT = clinicalContentAt('e1');

interface KeyRow {
  patient_id: string;
  kid: string;
  wrapped_dek: string;
}

/** `patient_data_keys` en memoria, con el `skipDuplicates` de la base. */
function fakeStore() {
  const rows = new Map<string, KeyRow>();
  const findUnique = jest.fn(({ where }: { where: { patient_id: string } }) =>
    Promise.resolve(rows.get(where.patient_id) ?? null),
  );
  const store = {
    patientDataKey: {
      findUnique,
      createMany: jest.fn(({ data }: { data: KeyRow[] }) => {
        let count = 0;
        for (const row of data) {
          if (!rows.has(row.patient_id)) {
            rows.set(row.patient_id, row);
            count += 1;
          }
        }
        return Promise.resolve({ count });
      }),
    },
  };
  return { rows, findUnique, store: store as unknown as PrismaService };
}

const ring = (...kids: string[]): Keyring =>
  parseKeyring(
    kids.map((kid) => `${kid}:${randomBytes(32).toString('base64')}`).join(','),
  )!;

/** ENG-216 — la DEK por paciente y su uso. */
describe('ClinicalDataCipher', () => {
  it('apagado (sin DATA_ENCRYPTION_KEYS): guarda y lee en claro, sin tocar la tabla de claves', async () => {
    const { store, findUnique } = fakeStore();
    const cipher = new ClinicalDataCipher(store, null);

    expect(cipher.enabled).toBe(false);
    expect(await cipher.sealJson(PATIENT, AT, CONTENT)).toBe(CONTENT);
    const openValue = await cipher.openerFor(PATIENT);
    expect(openValue(AT, CONTENT)).toBe(CONTENT);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('apagado y con algo cifrado: falla, nunca devuelve el cifrado como contenido', async () => {
    const { store } = fakeStore();
    const stored = await new ClinicalDataCipher(store, ring('k1')).sealJson(
      PATIENT,
      AT,
      CONTENT,
    );
    const openValue = await new ClinicalDataCipher(store, null).openerFor(
      PATIENT,
    );
    expect(() => openValue(AT, stored)).toThrow(MissingKeyError);
  });

  it('prendido: crea la DEK la primera vez, la reusa y descifra', async () => {
    const { store, rows } = fakeStore();
    const cipher = new ClinicalDataCipher(store, ring('k1'));

    const a = await cipher.sealJson(PATIENT, AT, CONTENT);
    const b = await cipher.sealJson(PATIENT, clinicalContentAt('e2'), CONTENT);

    expect(rows.size).toBe(1);
    expect(rows.get(PATIENT)!.kid).toBe('k1');
    expect(JSON.stringify(a)).not.toContain('Control');

    const openValue = await cipher.openerFor(PATIENT);
    expect(openValue(AT, a)).toEqual(CONTENT);
    expect(openValue(clinicalContentAt('e2'), b)).toEqual(CONTENT);
    // Lo viejo, en claro, pasa igual.
    expect(openValue(clinicalContentAt('e0'), CONTENT)).toBe(CONTENT);
  });

  it('la DEK guardada no es la DEK: está envuelta y atada a su paciente', async () => {
    const { store, rows } = fakeStore();
    const cipher = new ClinicalDataCipher(store, ring('k1'));
    const stored = await cipher.sealJson(PATIENT, AT, CONTENT);

    // La fila de la clave copiada a otro paciente no abre.
    rows.set(OTHER_PATIENT, {
      ...rows.get(PATIENT)!,
      patient_id: OTHER_PATIENT,
    });
    await expect(cipher.openerFor(OTHER_PATIENT)).rejects.toThrow(
      DecryptionError,
    );

    // Y el contenido de un paciente no se lee con la DEK de otro.
    rows.delete(OTHER_PATIENT);
    await cipher.sealJson(OTHER_PATIENT, AT, CONTENT);
    const ajeno = await cipher.openerFor(OTHER_PATIENT);
    expect(() => ajeno(AT, stored)).toThrow(DecryptionError);
  });

  it('dos escrituras simultáneas de un paciente nuevo usan la misma DEK', async () => {
    const { store, rows } = fakeStore();
    const cipher = new ClinicalDataCipher(store, ring('k1'));

    const [a, b] = await Promise.all([
      cipher.sealJson(PATIENT, AT, CONTENT),
      cipher.sealJson(PATIENT, clinicalContentAt('e2'), CONTENT),
    ]);

    expect(rows.size).toBe(1);
    const openValue = await cipher.openerFor(PATIENT);
    expect(openValue(AT, a)).toEqual(CONTENT);
    expect(openValue(clinicalContentAt('e2'), b)).toEqual(CONTENT);
  });

  it('después de sumar una clave maestra nueva, lo envuelto con la vieja se sigue leyendo', async () => {
    const { store, rows } = fakeStore();
    const k1 = ring('k1');
    const stored = await new ClinicalDataCipher(store, k1).sealJson(
      PATIENT,
      AT,
      CONTENT,
    );

    const k2 = ring('k2');
    const both: Keyring = {
      activeKid: 'k2',
      keys: new Map([...k1.keys, ...k2.keys]),
    };
    const rotated = new ClinicalDataCipher(store, both);
    expect((await rotated.openerFor(PATIENT))(AT, stored)).toEqual(CONTENT);
    // Las DEK nuevas se envuelven con la activa.
    await rotated.sealJson(OTHER_PATIENT, AT, CONTENT);
    expect(rows.get(OTHER_PATIENT)!.kid).toBe('k2');
  });

  it('si falta la clave maestra con la que se envolvió la DEK, lo dice sin mostrar nada', async () => {
    const { store } = fakeStore();
    await new ClinicalDataCipher(store, ring('k1')).sealJson(
      PATIENT,
      AT,
      CONTENT,
    );
    await expect(
      new ClinicalDataCipher(store, ring('k2')).openerFor(PATIENT),
    ).rejects.toThrow(MissingKeyError);
  });

  it('contenido cifrado de un paciente sin clave de datos: DecryptionError', async () => {
    const { store, rows } = fakeStore();
    const cipher = new ClinicalDataCipher(store, ring('k1'));
    const stored = await cipher.sealJson(PATIENT, AT, CONTENT);
    rows.clear();
    const openValue = await cipher.openerFor(PATIENT);
    expect(() => openValue(AT, stored)).toThrow(DecryptionError);
  });

  describe('archivos (ENG-216, parte 2)', () => {
    const FILE_AT = storedFileAt('patient-documents', 'obj-1');
    const PDF = Buffer.from('%PDF-1.7\nEcografía');

    it('cifra con la DEK del paciente (la crea si no estaba) y descifra', async () => {
      const { store, rows } = fakeStore();
      const cipher = new ClinicalDataCipher(store, ring('k1'));

      const blob = await cipher.sealFile(PATIENT, FILE_AT, PDF);
      expect(rows.has(PATIENT)).toBe(true);
      expect(blob.includes(Buffer.from('Ecografía'))).toBe(false);
      expect((await cipher.openFile(PATIENT, FILE_AT, blob)).equals(PDF)).toBe(
        true,
      );
    });

    it('la misma DEK sirve para la HC y para los archivos del paciente', async () => {
      const { store, rows } = fakeStore();
      const cipher = new ClinicalDataCipher(store, ring('k1'));
      await cipher.sealJson(PATIENT, AT, CONTENT);
      await cipher.sealFile(PATIENT, FILE_AT, PDF);
      expect(rows.size).toBe(1);
    });

    it('apagado: no cifra ni abre, y lo dice', async () => {
      const { store } = fakeStore();
      const off = new ClinicalDataCipher(store, null);
      await expect(off.sealFile(PATIENT, FILE_AT, PDF)).rejects.toThrow(
        MissingKeyError,
      );
      await expect(off.openFile(PATIENT, FILE_AT, PDF)).rejects.toThrow(
        MissingKeyError,
      );
    });

    it('el archivo de un paciente no abre con la DEK de otro', async () => {
      const { store } = fakeStore();
      const cipher = new ClinicalDataCipher(store, ring('k1'));
      const blob = await cipher.sealFile(PATIENT, FILE_AT, PDF);
      await cipher.sealFile(OTHER_PATIENT, FILE_AT, PDF);
      await expect(
        cipher.openFile(OTHER_PATIENT, FILE_AT, blob),
      ).rejects.toThrow(DecryptionError);
    });
  });

  describe('links de descarga de archivos cifrados', () => {
    const TICKET: FileTicket = {
      bucket: 'patient-documents',
      path: `${PATIENT}/obj-1.pdf.enc`,
      patientId: PATIENT,
      mime: 'application/pdf',
      attachment: true,
    };
    const NOW = new Date('2026-11-22T12:00:00.000Z');
    const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

    it('lee lo que firmó, mientras no venza', () => {
      const cipher = new ClinicalDataCipher(fakeStore().store, ring('k1'));
      const token = cipher.signFileTicket(TICKET, 300, NOW);
      expect(cipher.readFileTicket(token, later(299))).toEqual(TICKET);
      expect(cipher.readFileTicket(token, later(300))).toBeNull();
    });

    it('no deja ver qué archivo ni de qué paciente es', () => {
      const cipher = new ClinicalDataCipher(fakeStore().store, ring('k1'));
      const token = cipher.signFileTicket(TICKET, 300, NOW);
      expect(token.startsWith('k1.')).toBe(true);
      const visible = token
        .split('.')
        .map((part) => Buffer.from(part, 'base64url').toString('latin1'))
        .join(' ');
      expect(visible).not.toContain(PATIENT);
      expect(visible).not.toContain('patient-documents');
      expect(token).not.toContain(PATIENT);
    });

    it('alterado, de otra clave, mal formado o sin cifrado: null', () => {
      const cipher = new ClinicalDataCipher(fakeStore().store, ring('k1'));
      const token = cipher.signFileTicket(TICKET, 300, NOW);
      const parts = token.split('.');
      const last = Buffer.from(parts[3], 'base64url');
      last[0] ^= 1;
      parts[3] = last.toString('base64url');

      expect(cipher.readFileTicket(parts.join('.'), NOW)).toBeNull();
      expect(
        new ClinicalDataCipher(fakeStore().store, ring('k1')).readFileTicket(
          token,
          NOW,
        ),
      ).toBeNull();
      expect(cipher.readFileTicket('', NOW)).toBeNull();
      expect(cipher.readFileTicket('k1', NOW)).toBeNull();
      expect(cipher.readFileTicket('k9.a.b.c', NOW)).toBeNull();
      expect(cipher.readFileTicket('basura total', NOW)).toBeNull();
      expect(
        new ClinicalDataCipher(fakeStore().store, null).readFileTicket(
          token,
          NOW,
        ),
      ).toBeNull();
    });

    it('un link de antes de sumar una clave nueva sigue sirviendo hasta que vence', () => {
      const k1 = ring('k1');
      const token = new ClinicalDataCipher(
        fakeStore().store,
        k1,
      ).signFileTicket(TICKET, 300, NOW);
      const both: Keyring = {
        activeKid: 'k2',
        keys: new Map([...k1.keys, ...ring('k2').keys]),
      };
      expect(
        new ClinicalDataCipher(fakeStore().store, both).readFileTicket(
          token,
          NOW,
        ),
      ).toEqual(TICKET);
    });

    it('sin la clave no se puede firmar', () => {
      expect(() =>
        new ClinicalDataCipher(fakeStore().store, null).signFileTicket(
          TICKET,
          300,
        ),
      ).toThrow(MissingKeyError);
    });
  });
});
