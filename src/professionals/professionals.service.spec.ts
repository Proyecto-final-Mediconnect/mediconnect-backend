import { BadRequestException, NotFoundException } from '@nestjs/common';
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
  professional_specialties: [
    { specialty: { id: 's1', name: 'Cardiología' } },
    { specialty: null }, // link colgado: debe filtrarse
  ],
};

/**
 * Cliente Supabase mock: cada método de la cadena (`from().select().eq()...`)
 * devuelve el mismo builder, que es "thenable" y al await-earse resuelve el
 * próximo resultado de la cola. Así se soportan tanto lecturas
 * (`.maybeSingle()`) como escrituras (`.update().eq()`).
 */
function makeClient(results: Array<{ data: unknown; error: unknown }>) {
  const queue = [...results];
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(queue.shift() ?? { data: null, error: null });
        }
        return () => builder;
      },
    },
  );
  return {
    from: () => builder,
    storage: {
      from: () => ({
        upload: jest.fn().mockResolvedValue({ data: {}, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://cdn/x.jpg' } }),
      }),
    },
  };
}

function makeService(results: Array<{ data: unknown; error: unknown }>) {
  const client = makeClient(results);
  const supabaseMock = {
    getClient: () => client,
    getClientForToken: () => client,
  } as unknown as SupabaseService;
  return new ProfessionalsService(supabaseMock);
}

describe('ProfessionalsService', () => {
  describe('getMyProfile', () => {
    it('mapea la fila a la forma de la API (camelCase, precio numérico, especialidades planas)', async () => {
      const service = makeService([{ data: PRO_ROW, error: null }]);

      const profile = await service.getMyProfile('token', 'user-1');

      expect(profile.firstName).toBe('Ana');
      expect(profile.consultationPrice).toBe(15000);
      expect(profile.specialties).toEqual([{ id: 's1', name: 'Cardiología' }]);
      expect(profile.photoUrl).toBeNull();
    });

    it('lanza NotFound si el usuario no tiene perfil profesional', async () => {
      const service = makeService([{ data: null, error: null }]);

      await expect(service.getMyProfile('token', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateMyProfile', () => {
    it('rechaza especialidades que no existen en el catálogo', async () => {
      // 1) getMyProfile → existe. 2) assertSpecialtiesExist → solo encuentra 1.
      const service = makeService([
        { data: PRO_ROW, error: null },
        { data: [{ id: 's1' }], error: null },
      ]);

      await expect(
        service.updateMyProfile('token', 'user-1', {
          specialtyIds: ['s1', 's2'],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('uploadPhoto', () => {
    const buffer = Buffer.from('x');

    it('rechaza tipos de archivo no permitidos', async () => {
      const service = makeService([]);

      await expect(
        service.uploadPhoto('token', 'user-1', {
          buffer,
          mimetype: 'application/pdf',
          size: 100,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza fotos que superan el máximo de tamaño', async () => {
      const service = makeService([]);

      await expect(
        service.uploadPhoto('token', 'user-1', {
          buffer,
          mimetype: 'image/jpeg',
          size: 5 * 1024 * 1024,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
