import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PatientsService } from './patients.service';
import { UpdatePatientProfileDto } from './dto/update-patient-profile.dto';

/** Fila de `patients` como la devuelve PostgREST, para verificar el mapeo. */
const PATIENT_ROW = {
  profile_id: 'user-1',
  first_name: 'Ana',
  last_name: 'Paciente',
  birth_date: '1990-05-20',
  dni: '12345678',
  phone: '+54 11 5555-5555',
};

/** DTO válido base; cada test clona y ajusta lo que necesita. */
const validDto: UpdatePatientProfileDto = {
  firstName: 'Ana',
  lastName: 'Paciente',
  birthDate: '1990-05-20',
  dni: '12345678',
  phone: '+54 11 5555-5555',
};

/**
 * Cliente Supabase mock: cada método de la cadena (`from().select().eq()...`)
 * devuelve el mismo builder "thenable"; al await-earse resuelve el próximo
 * resultado de la cola. Cubre lecturas (`.maybeSingle()`) y escrituras
 * (`.upsert()`).
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
  return { from: () => builder };
}

function makeService(results: Array<{ data: unknown; error: unknown }>) {
  const client = makeClient(results);
  const supabaseMock = {
    getClient: () => client,
    getClientForToken: () => client,
  } as unknown as SupabaseService;
  return new PatientsService(supabaseMock);
}

describe('PatientsService', () => {
  describe('getMyProfile', () => {
    it('mapea la fila a la forma de la API (camelCase) y marca completed', async () => {
      const service = makeService([{ data: PATIENT_ROW, error: null }]);

      const profile = await service.getMyProfile('token', 'user-1');

      expect(profile.firstName).toBe('Ana');
      expect(profile.dni).toBe('12345678');
      expect(profile.completed).toBe(true);
    });

    it('devuelve un perfil vacío con completed=false si aún no lo completó', async () => {
      const service = makeService([{ data: null, error: null }]);

      const profile = await service.getMyProfile('token', 'user-1');

      expect(profile.completed).toBe(false);
      expect(profile.firstName).toBeNull();
      expect(profile.profileId).toBe('user-1');
    });
  });

  describe('updateMyProfile', () => {
    it('hace upsert y devuelve el perfil recién guardado', async () => {
      // 1) upsert ok. 2) getMyProfile relee la fila.
      const service = makeService([
        { data: null, error: null },
        { data: PATIENT_ROW, error: null },
      ]);

      const profile = await service.updateMyProfile(
        'token',
        'user-1',
        validDto,
      );

      expect(profile.completed).toBe(true);
      expect(profile.lastName).toBe('Paciente');
    });

    it('traduce el DNI duplicado (unique violation) a un 409 claro', async () => {
      const service = makeService([{ data: null, error: { code: '23505' } }]);

      await expect(
        service.updateMyProfile('token', 'user-1', validDto),
      ).rejects.toThrow(ConflictException);
    });

    it('ante otro error de la base lanza 500 sin filtrar el detalle crudo', async () => {
      const service = makeService([
        { data: null, error: { code: '42501', message: 'permission denied' } },
      ]);

      await expect(
        service.updateMyProfile('token', 'user-1', validDto),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('rechaza una fecha de nacimiento futura', async () => {
      const service = makeService([]);
      const future = new Date();
      future.setFullYear(future.getFullYear() + 1);
      const dto = { ...validDto, birthDate: future.toISOString().slice(0, 10) };

      await expect(
        service.updateMyProfile('token', 'user-1', dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza una edad imposible (fecha demasiado antigua)', async () => {
      const service = makeService([]);
      const dto = { ...validDto, birthDate: '1850-01-01' };

      await expect(
        service.updateMyProfile('token', 'user-1', dto),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
