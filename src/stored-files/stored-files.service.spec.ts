import {
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { encryptingCipher } from '../../test/memory-key-store';
import { ClinicalDataCipher } from '../common/crypto/clinical-data-cipher';
import { MAX_FILE_BYTES } from '../common/files/file-signature';
import type { PrismaService } from '../prisma/prisma.service';
import type { SupabaseService } from '../supabase/supabase.service';
import {
  FILE_LINK_TTL_SECONDS,
  isEncryptedObject,
  objectIdOf,
  StoredFilesService,
} from './stored-files.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://api.test';
const PDF = Buffer.from('%PDF-1.7\nResonancia de rodilla');

/** Storage en memoria. */
function setup({ encrypted }: { encrypted: boolean }) {
  const objects = new Map<string, Buffer>();
  const download = jest.fn((path: string) => {
    const bytes = objects.get(path);
    return Promise.resolve(
      bytes
        ? { data: new Blob([new Uint8Array(bytes)]), error: null }
        : { data: null, error: { message: 'Object not found' } },
    );
  });
  const supabase = {
    getServiceClient: () => ({ storage: { from: () => ({ download }) } }),
  } as unknown as SupabaseService;
  const cipher = encrypted
    ? encryptingCipher()
    : new ClinicalDataCipher({} as PrismaService, null);
  return {
    objects,
    download,
    cipher,
    files: new StoredFilesService(supabase, cipher),
  };
}

const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;

/** ENG-216, parte 2 — archivos cifrados en Storage. */
describe('StoredFilesService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('objectIdOf e isEncryptedObject leen el nombre del objeto', () => {
    expect(objectIdOf(`${PATIENT}/abc-123.pdf.enc`)).toBe('abc-123');
    expect(objectIdOf(`${PATIENT}/abc-123.pdf`)).toBe('abc-123');
    expect(isEncryptedObject(`${PATIENT}/abc-123.pdf.enc`)).toBe(true);
    expect(isEncryptedObject(`${PATIENT}/abc-123.pdf`)).toBe(false);
  });

  describe('cifrado apagado (sin DATA_ENCRYPTION_KEYS)', () => {
    it('sube el archivo tal cual, con el nombre de siempre y el tope de siempre', async () => {
      const { files } = setup({ encrypted: false });
      const { path, body } = await files.prepareUpload(
        'patient-documents',
        PATIENT,
        PATIENT,
        'pdf',
        PDF,
      );
      expect(path).toMatch(new RegExp(`^${PATIENT}/[0-9a-f-]{36}\\.pdf$`));
      expect(body).toBe(PDF);
      expect(files.maxFileBytes).toBe(MAX_FILE_BYTES);
    });
  });

  describe('cifrado prendido', () => {
    it('sube cifrado, con .enc, y el tope deja lugar a los 32 bytes del cifrado', async () => {
      const { files } = setup({ encrypted: true });
      const { path, body } = await files.prepareUpload(
        'chat-attachments',
        CONVERSATION,
        PATIENT,
        'pdf',
        PDF,
      );
      expect(path).toMatch(
        new RegExp(`^${CONVERSATION}/[0-9a-f-]{36}\\.pdf\\.enc$`),
      );
      expect(body.includes(Buffer.from('Resonancia'))).toBe(false);
      expect(files.maxFileBytes).toBe(MAX_FILE_BYTES - 32);
    });

    it('el link del backend abre el archivo original', async () => {
      const { files, objects } = setup({ encrypted: true });
      const { path, body } = await files.prepareUpload(
        'patient-documents',
        PATIENT,
        PATIENT,
        'pdf',
        PDF,
      );
      objects.set(path, body);

      const now = new Date();
      const link = files.link(
        BASE,
        {
          bucket: 'patient-documents',
          path,
          patientId: PATIENT,
          mime: 'application/pdf',
          attachment: true,
        },
        now,
      );
      expect(link.url.startsWith(`${BASE}/files?t=`)).toBe(true);
      expect(link.url).not.toContain(PATIENT);
      expect(link.expiresAt).toBe(
        new Date(now.getTime() + FILE_LINK_TTL_SECONDS * 1000).toISOString(),
      );

      const opened = await files.open(tokenOf(link.url));
      expect(opened.bytes.equals(PDF)).toBe(true);
      expect(opened).toMatchObject({
        mime: 'application/pdf',
        attachment: true,
        filename: 'documento.pdf',
      });
    });

    it('un link alterado o vencido da 404 sin tocar Storage', async () => {
      const { files, download } = setup({ encrypted: true });
      const link = files.link(BASE, {
        bucket: 'patient-documents',
        path: `${PATIENT}/x.pdf.enc`,
        patientId: PATIENT,
        mime: 'application/pdf',
        attachment: true,
      });
      const token = tokenOf(link.url);
      await expect(files.open(`${token}x`)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(files.open('basura')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      jest.useFakeTimers({ now: Date.now() + FILE_LINK_TTL_SECONDS * 1000 });
      try {
        await expect(files.open(token)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      } finally {
        jest.useRealTimers();
      }
      expect(download).not.toHaveBeenCalled();
    });

    it('solo sirve objetos cifrados de los dos buckets clínicos', async () => {
      const { files, cipher, download } = setup({ encrypted: true });
      const sign = (bucket: string, path: string) =>
        cipher.signFileTicket(
          {
            bucket,
            path,
            patientId: PATIENT,
            mime: 'image/png',
            attachment: false,
          },
          300,
        );
      await expect(
        files.open(sign('avatars', `${PATIENT}/x.png.enc`)),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        files.open(sign('patient-documents', `${PATIENT}/x.png`)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(download).not.toHaveBeenCalled();
    });

    it('un archivo alterado en Storage no se manda: 500 y log sin contenido', async () => {
      const { files, objects } = setup({ encrypted: true });
      const { path, body } = await files.prepareUpload(
        'patient-documents',
        PATIENT,
        PATIENT,
        'pdf',
        PDF,
      );
      const alterado = Buffer.from(body);
      alterado[alterado.length - 1] ^= 1;
      objects.set(path, alterado);
      const error = jest.spyOn(Logger.prototype, 'error');

      const { url } = files.link(BASE, {
        bucket: 'patient-documents',
        path,
        patientId: PATIENT,
        mime: 'application/pdf',
        attachment: true,
      });
      await expect(files.open(tokenOf(url))).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('DecryptionError'),
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain('Resonancia');
    });

    it('un objeto que no está en Storage da 500', async () => {
      const { files } = setup({ encrypted: true });
      const { url } = files.link(BASE, {
        bucket: 'chat-attachments',
        path: `${CONVERSATION}/no-esta.png.enc`,
        patientId: PATIENT,
        mime: 'image/png',
        attachment: false,
      });
      await expect(files.open(tokenOf(url))).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });
});
