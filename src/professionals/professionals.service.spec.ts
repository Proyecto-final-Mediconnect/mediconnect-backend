import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ProfessionalsService } from './professionals.service';

/** Fila de `professionals` (con especialidades anidadas) como la devuelve
 *  PostgREST, usada para verificar el mapeo a la forma de la API. */
const PRO_ROW = {
  profile_id: 'user-1',
  first_name: 'Ana',
  last_name: 'García',
  license_number: 'MP-12345',
  bio: 'Cardióloga con 10 años de experiencia.',
  photo_url: null,
  consultation_price: '15000.00', // numeric → string en PostgREST
  currency: 'ARS',
  status: 'ACTIVO',
  updated_at: '2026-07-29T12:00:00.000Z',
  professional_specialties: [
    { specialty: { id: 's1', name: 'Cardiología' } },
    { specialty: null }, // link colgado: debe filtrarse
  ],
};

/** La sonda de existencia previa a una escritura (`select profile_id`). */
const PROFILE_EXISTS = { data: { profile_id: 'user-1' }, error: null };
const OK = { data: null, error: null };

/** Llamada registrada sobre el cliente mock, para poder afirmar QUÉ se le mandó
 *  a PostgREST (no solo que no explotó). */
type RecordedCall = { method: string; args: unknown[] };

/**
 * Cliente Supabase mock: cada método de la cadena (`from().select().eq()...`)
 * devuelve el mismo builder, que es "thenable" y al await-earse resuelve el
 * próximo resultado de la cola. Así se soportan tanto lecturas
 * (`.maybeSingle()`) como escrituras (`.update().eq()`).
 *
 * Además registra cada llamada con sus argumentos en `calls`: sin eso los tests
 * solo pueden verificar el mapeo de salida, no el payload que se escribe.
 */
function makeClient(
  results: Array<{ data: unknown; error: unknown }>,
  calls: RecordedCall[],
) {
  const queue = [...results];
  const record = (method: string, args: unknown[]) =>
    calls.push({ method, args });
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(queue.shift() ?? { data: null, error: null });
        }
        return (...args: unknown[]) => {
          record(String(prop), args);
          return builder;
        };
      },
    },
  );
  return {
    from: (table: string) => {
      record('from', [table]);
      return builder;
    },
    storage: {
      from: () => ({
        upload: (path: string, _buffer: Buffer, options: unknown) => {
          record('storage.upload', [path, options]);
          return Promise.resolve({ data: {}, error: null });
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://cdn/professional-photos/${path}` },
        }),
      }),
    },
  };
}

function makeService(results: Array<{ data: unknown; error: unknown }>) {
  const calls: RecordedCall[] = [];
  const client = makeClient(results, calls);
  const supabaseMock = {
    getClient: () => client,
    getClientForToken: () => client,
  } as unknown as SupabaseService;
  return { service: new ProfessionalsService(supabaseMock), calls, client };
}

/** Último payload pasado a `.update(...)`. */
function lastUpdatePayload(calls: RecordedCall[]) {
  const updates = calls.filter((c) => c.method === 'update');
  return updates.at(-1)?.args[0] as Record<string, unknown> | undefined;
}

describe('ProfessionalsService', () => {
  describe('getMyProfile', () => {
    it('mapea la fila a la forma de la API (camelCase, precio numérico, especialidades planas)', async () => {
      const { service } = makeService([{ data: PRO_ROW, error: null }]);

      const profile = await service.getMyProfile('token', 'user-1');

      expect(profile.firstName).toBe('Ana');
      expect(profile.consultationPrice).toBe(15000);
      expect(profile.specialties).toEqual([{ id: 's1', name: 'Cardiología' }]);
      expect(profile.photoUrl).toBeNull();
    });

    it('lanza NotFound si el usuario no tiene perfil profesional', async () => {
      const { service } = makeService([{ data: null, error: null }]);

      await expect(service.getMyProfile('token', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('versiona la URL de la foto con updated_at, sin tocar lo persistido', async () => {
      const { service } = makeService([
        {
          data: {
            ...PRO_ROW,
            photo_url: 'https://cdn/professional-photos/user-1/avatar.png',
          },
          error: null,
        },
      ]);

      const profile = await service.getMyProfile('token', 'user-1');

      // El `?v=` se deriva de updated_at: estable entre lecturas (no Date.now()).
      expect(profile.photoUrl).toBe(
        `https://cdn/professional-photos/user-1/avatar.png?v=${Date.parse(
          PRO_ROW.updated_at,
        )}`,
      );
    });

    it('deja la URL intacta si updated_at no es una fecha parseable', async () => {
      const { service } = makeService([
        {
          data: {
            ...PRO_ROW,
            photo_url: 'https://cdn/x.png',
            updated_at: 'ups',
          },
          error: null,
        },
      ]);

      const profile = await service.getMyProfile('token', 'user-1');

      expect(profile.photoUrl).toBe('https://cdn/x.png');
    });
  });

  describe('updateMyProfile', () => {
    it('rechaza especialidades que no existen en el catálogo', async () => {
      // 1) sonda de perfil → existe. 2) assertSpecialtiesExist → solo encuentra 1.
      const { service } = makeService([
        PROFILE_EXISTS,
        { data: [{ id: 's1' }], error: null },
      ]);

      await expect(
        service.updateMyProfile('token', 'user-1', {
          specialtyIds: ['s1', 's2'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('escribe consultation_price en null cuando el precio viene en null (borrar el precio)', async () => {
      const { service, calls } = makeService([
        PROFILE_EXISTS,
        OK, // update
        { data: { ...PRO_ROW, consultation_price: null }, error: null }, // relectura
      ]);

      const profile = await service.updateMyProfile('token', 'user-1', {
        consultationPrice: null,
      });

      expect(lastUpdatePayload(calls)).toMatchObject({
        consultation_price: null,
      });
      expect(profile.consultationPrice).toBeNull();
    });

    it('no toca el precio cuando el campo no viene en el payload', async () => {
      const { service, calls } = makeService([
        PROFILE_EXISTS,
        OK, // update
        { data: PRO_ROW, error: null }, // relectura
      ]);

      await service.updateMyProfile('token', 'user-1', { bio: 'Nueva bio' });

      const payload = lastUpdatePayload(calls)!;
      expect(payload).toHaveProperty('bio', 'Nueva bio');
      expect(payload).not.toHaveProperty('consultation_price');
    });

    it('ante un fallo de la base habla de guardar, no de cargar', async () => {
      // La sonda previa a la escritura falla: el usuario pidió guardar.
      const { service } = makeService([
        { data: null, error: { message: 'permission denied' } },
      ]);

      await expect(
        service.updateMyProfile('token', 'user-1', { bio: 'x' }),
      ).rejects.toThrow(
        new InternalServerErrorException(
          'No pudimos guardar tu perfil. Probá de nuevo en unos minutos.',
        ),
      );
    });

    it('si la escritura funcionó y falla la relectura, no dice que no se guardó', async () => {
      const { service } = makeService([
        PROFILE_EXISTS,
        OK, // update: ok
        { data: null, error: { message: 'boom' } }, // relectura: falla
      ]);

      await expect(
        service.updateMyProfile('token', 'user-1', { bio: 'x' }),
      ).rejects.toThrow(/Guardamos tus cambios/);
    });
  });

  describe('uploadPhoto', () => {
    const buffer = Buffer.from('x');

    it('rechaza tipos de archivo no permitidos', async () => {
      const { service } = makeService([]);

      await expect(
        service.uploadPhoto('token', 'user-1', {
          buffer,
          mimetype: 'application/pdf',
          size: 100,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza fotos que superan el máximo de tamaño', async () => {
      const { service } = makeService([]);

      await expect(
        service.uploadPhoto('token', 'user-1', {
          buffer,
          mimetype: 'image/jpeg',
          size: 5 * 1024 * 1024,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('sube a la carpeta del usuario y persiste la URL canónica (sin ?v=)', async () => {
      const { service, calls } = makeService([
        PROFILE_EXISTS,
        OK, // update de photo_url
        {
          data: {
            ...PRO_ROW,
            photo_url: 'https://cdn/professional-photos/user-1/avatar.png',
          },
          error: null,
        },
      ]);

      const profile = await service.uploadPhoto('token', 'user-1', {
        buffer,
        mimetype: 'image/png',
        size: 1024,
      });

      // La ruta con prefijo del uid es la que habilita la política RLS de Storage.
      expect(calls).toEqual(
        expect.arrayContaining([
          {
            method: 'storage.upload',
            args: [
              'user-1/avatar.png',
              { contentType: 'image/png', upsert: true },
            ],
          },
        ]),
      );

      const payload = lastUpdatePayload(calls)!;
      expect(payload.photo_url).toBe(
        'https://cdn/professional-photos/user-1/avatar.png',
      );
      expect(String(payload.photo_url)).not.toContain('?v=');

      // Pero lo que sale por la API sí va versionado.
      expect(profile.photoUrl).toContain('?v=');
    });
  });
});
