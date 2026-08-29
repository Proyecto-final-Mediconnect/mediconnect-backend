import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { SchedulesService } from './schedules.service';

/** La sonda de existencia previa a una escritura (`select profile_id`). */
const PROFILE_EXISTS = { data: { profile_id: 'user-1' }, error: null };
const OK = { data: null, error: null };

const RULE_ROW = {
  id: 'rule-1',
  weekday: 2,
  start_time: '09:00:00',
  end_time: '13:00:00',
  slot_duration_minutes: 30,
};

const BLOCK_ROW = {
  id: 'block-1',
  block_date: '2026-09-01',
  start_time: '14:00:00',
  end_time: '16:00:00',
  reason: 'Congreso',
};

const FULL_DAY_BLOCK_ROW = {
  id: 'block-2',
  block_date: '2026-09-02',
  start_time: null,
  end_time: null,
  reason: null,
};

type RecordedCall = { method: string; args: unknown[] };

/**
 * Mismo cliente mock que usa `professionals.service.spec.ts`: la cadena
 * (`from().select().eq()...`) devuelve siempre el mismo builder, que es
 * "thenable" y al await-earse resuelve el próximo resultado de la cola.
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
  };
}

function makeService(results: Array<{ data: unknown; error: unknown }>) {
  const calls: RecordedCall[] = [];
  const client = makeClient(results, calls);
  const supabaseMock = {
    getClient: () => client,
    getClientForToken: () => client,
  } as unknown as SupabaseService;
  return { service: new SchedulesService(supabaseMock), calls };
}

/** Payload de la última llamada a `.insert(...)`. */
function lastInsertPayload(calls: RecordedCall[]) {
  return calls.filter((c) => c.method === 'insert').at(-1)?.args[0];
}

/** Agenda válida mínima, para los casos donde la validación no es lo que se prueba. */
const VALID_RULES = {
  rules: [
    {
      weekday: 2,
      startTime: '09:00',
      endTime: '13:00',
      slotDurationMinutes: 30,
    },
  ],
};

describe('SchedulesService (ENG-53)', () => {
  describe('getMySchedule', () => {
    it('mapea reglas y bloqueos a la forma de la API (camelCase, HH:MM)', async () => {
      const { service } = makeService([
        { data: [RULE_ROW], error: null },
        { data: [BLOCK_ROW, FULL_DAY_BLOCK_ROW], error: null },
      ]);

      const schedule = await service.getMySchedule('token', 'user-1');

      expect(schedule.rules).toEqual([
        {
          id: 'rule-1',
          weekday: 2,
          startTime: '09:00',
          endTime: '13:00',
          slotDurationMinutes: 30,
        },
      ]);
      expect(schedule.blocks[0].startTime).toBe('14:00');
      // Día completo: las horas quedan en null, no en un string vacío.
      expect(schedule.blocks[1].startTime).toBeNull();
      expect(schedule.blocks[1].endTime).toBeNull();
    });

    it('devuelve listas vacías cuando el profesional no cargó agenda', async () => {
      const { service } = makeService([
        { data: [], error: null },
        { data: [], error: null },
      ]);

      const schedule = await service.getMySchedule('token', 'user-1');

      expect(schedule).toEqual({ rules: [], blocks: [] });
    });

    it('filtra los bloqueos vencidos por la fecha de Argentina, no la de UTC', async () => {
      // 02:00 UTC del 14 = 23:00 del 13 en Argentina. El backend corre en UTC
      // (Render), así que con `toISOString()` el corte daría 2026-08-14 y los
      // bloqueos de HOY desaparecerían de la lista tres horas antes de tiempo.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-14T02:00:00Z'));

      const { service, calls } = makeService([
        { data: [], error: null },
        { data: [], error: null },
      ]);

      await service.getMySchedule('token', 'user-1');

      const gte = calls.find((c) => c.method === 'gte');
      expect(gte?.args).toEqual(['block_date', '2026-08-13']);

      jest.useRealTimers();
    });
  });

  describe('saveMyRules — validaciones previas a tocar la base', () => {
    it('rechaza franjas superpuestas del mismo día', async () => {
      const { service, calls } = makeService([]);

      await expect(
        service.saveMyRules('token', 'user-1', {
          rules: [
            {
              weekday: 3,
              startTime: '09:00',
              endTime: '13:00',
              slotDurationMinutes: 30,
            },
            {
              weekday: 3,
              startTime: '12:00',
              endTime: '16:00',
              slotDurationMinutes: 30,
            },
          ],
        }),
      ).rejects.toThrow(BadRequestException);

      // No debe haber borrado la agenda anterior antes de fallar.
      expect(calls).toHaveLength(0);
    });

    it('rechaza una franja cuyo fin es anterior al inicio', async () => {
      const { service } = makeService([]);

      await expect(
        service.saveMyRules('token', 'user-1', {
          rules: [
            {
              weekday: 1,
              startTime: '18:00',
              endTime: '09:00',
              slotDurationMinutes: 30,
            },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza una franja más corta que la duración del turno', async () => {
      const { service } = makeService([]);

      await expect(
        service.saveMyRules('token', 'user-1', {
          rules: [
            {
              weekday: 1,
              startTime: '09:00',
              endTime: '09:20',
              slotDurationMinutes: 30,
            },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('acepta turno mañana y turno tarde el mismo día', async () => {
      const { service } = makeService([
        PROFILE_EXISTS,
        OK, // delete
        OK, // insert
        { data: [], error: null },
        { data: [], error: null },
      ]);

      await expect(
        service.saveMyRules('token', 'user-1', {
          rules: [
            {
              weekday: 2,
              startTime: '09:00',
              endTime: '13:00',
              slotDurationMinutes: 30,
            },
            {
              weekday: 2,
              startTime: '16:00',
              endTime: '20:00',
              slotDurationMinutes: 30,
            },
          ],
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('saveMyRules — escritura', () => {
    it('escribe las horas en el formato time de Postgres y con el dueño correcto', async () => {
      const { service, calls } = makeService([
        PROFILE_EXISTS,
        OK,
        OK,
        { data: [RULE_ROW], error: null },
        { data: [], error: null },
      ]);

      await service.saveMyRules('token', 'user-1', VALID_RULES);

      expect(lastInsertPayload(calls)).toEqual([
        {
          professional_id: 'user-1',
          weekday: 2,
          start_time: '09:00:00',
          end_time: '13:00:00',
          slot_duration_minutes: 30,
        },
      ]);
    });

    it('con rules vacío borra la agenda y no inserta nada', async () => {
      const { service, calls } = makeService([
        PROFILE_EXISTS,
        OK, // delete
        { data: [], error: null },
        { data: [], error: null },
      ]);

      const schedule = await service.saveMyRules('token', 'user-1', {
        rules: [],
      });

      expect(calls.some((c) => c.method === 'delete')).toBe(true);
      expect(calls.some((c) => c.method === 'insert')).toBe(false);
      expect(schedule.rules).toEqual([]);
    });

    it('da 404 si el usuario no tiene perfil profesional', async () => {
      const { service } = makeService([{ data: null, error: null }]);

      await expect(
        service.saveMyRules('token', 'user-1', VALID_RULES),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createBlock', () => {
    it('rechaza que venga solo una de las dos horas', async () => {
      const { service, calls } = makeService([]);

      await expect(
        service.createBlock('token', 'user-1', {
          blockDate: '2026-09-01',
          startTime: '14:00',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(calls).toHaveLength(0);
    });

    it('rechaza un rango con fin anterior al inicio', async () => {
      const { service } = makeService([]);

      await expect(
        service.createBlock('token', 'user-1', {
          blockDate: '2026-09-01',
          startTime: '16:00',
          endTime: '14:00',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('sin horas guarda el bloqueo como día completo (null, null)', async () => {
      const { service, calls } = makeService([
        PROFILE_EXISTS,
        { data: FULL_DAY_BLOCK_ROW, error: null },
      ]);

      const block = await service.createBlock('token', 'user-1', {
        blockDate: '2026-09-02',
      });

      expect(lastInsertPayload(calls)).toEqual({
        professional_id: 'user-1',
        block_date: '2026-09-02',
        start_time: null,
        end_time: null,
        reason: null,
      });
      expect(block.startTime).toBeNull();
    });

    it('con horas guarda solo esa franja del día', async () => {
      const { service, calls } = makeService([
        PROFILE_EXISTS,
        { data: BLOCK_ROW, error: null },
      ]);

      const block = await service.createBlock('token', 'user-1', {
        blockDate: '2026-09-01',
        startTime: '14:00',
        endTime: '16:00',
        reason: 'Congreso',
      });

      expect(lastInsertPayload(calls)).toMatchObject({
        start_time: '14:00:00',
        end_time: '16:00:00',
        reason: 'Congreso',
      });
      expect(block.endTime).toBe('16:00');
    });

    it('traduce el unique violation a 409 en vez de 500', async () => {
      const { service } = makeService([
        PROFILE_EXISTS,
        { data: null, error: { code: '23505' } },
      ]);

      await expect(
        service.createBlock('token', 'user-1', { blockDate: '2026-09-02' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteBlock', () => {
    it('da 404 cuando el bloqueo no existe o es de otro profesional', async () => {
      // RLS ya lo haría invisible; el delete no afecta filas y devuelve [].
      const { service } = makeService([{ data: [], error: null }]);

      await expect(
        service.deleteBlock('token', 'user-1', 'block-9'),
      ).rejects.toThrow(NotFoundException);
    });

    it('acota el delete al bloqueo y a su dueño', async () => {
      const { service, calls } = makeService([
        { data: [{ id: 'block-1' }], error: null },
      ]);

      await service.deleteBlock('token', 'user-1', 'block-1');

      const eqCalls = calls.filter((c) => c.method === 'eq');
      expect(eqCalls.map((c) => c.args)).toEqual([
        ['id', 'block-1'],
        ['professional_id', 'user-1'],
      ]);
    });
  });
});
