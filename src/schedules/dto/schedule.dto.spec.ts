import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateScheduleBlockDto } from './create-schedule-block.dto';
import { MAX_RULES, SaveScheduleDto } from './save-schedule.dto';

/** Propiedades inválidas de primer nivel. */
async function invalidProps(
  cls: new () => object,
  obj: Record<string, unknown>,
): Promise<string[]> {
  const dto = plainToInstance(cls, obj);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

/** Aplana los errores anidados de `rules[]` a los nombres de sus propiedades.
 *  Sin esto, un error dentro de una regla solo se ve como "rules". */
async function invalidRuleProps(
  obj: Record<string, unknown>,
): Promise<string[]> {
  const dto = plainToInstance(SaveScheduleDto, obj);
  const errors = await validate(dto);
  return errors
    .flatMap((e) => e.children ?? [])
    .flatMap((item) => item.children ?? [])
    .map((e) => e.property);
}

const VALID_RULE = {
  weekday: 2,
  startTime: '09:00',
  endTime: '13:00',
  slotDurationMinutes: 30,
};

describe('SaveScheduleDto (ENG-53)', () => {
  it('acepta una agenda válida', async () => {
    expect(
      await invalidProps(SaveScheduleDto, { rules: [VALID_RULE] }),
    ).toHaveLength(0);
  });

  it('acepta rules vacío — es cómo se despublica la agenda', async () => {
    expect(await invalidProps(SaveScheduleDto, { rules: [] })).toHaveLength(0);
  });

  it('exige que rules sea una lista', async () => {
    expect(await invalidProps(SaveScheduleDto, { rules: 'lunes' })).toContain(
      'rules',
    );
  });

  it(`rechaza más de ${MAX_RULES} franjas`, async () => {
    const rules = Array.from({ length: MAX_RULES + 1 }, () => VALID_RULE);

    expect(await invalidProps(SaveScheduleDto, { rules })).toContain('rules');
  });

  describe('validación anidada de cada franja', () => {
    it('rechaza un weekday fuera de 0-6', async () => {
      expect(
        await invalidRuleProps({ rules: [{ ...VALID_RULE, weekday: 7 }] }),
      ).toContain('weekday');
      expect(
        await invalidRuleProps({ rules: [{ ...VALID_RULE, weekday: -1 }] }),
      ).toContain('weekday');
    });

    it('acepta los dos extremos del rango de días', async () => {
      expect(
        await invalidRuleProps({
          rules: [
            { ...VALID_RULE, weekday: 0 },
            { ...VALID_RULE, weekday: 6 },
          ],
        }),
      ).toHaveLength(0);
    });

    it('rechaza horas que no sean HH:MM de 24 h', async () => {
      const casos = ['9:00', '25:00', '09:60', '09:00:00', 'mañana', ''];

      for (const startTime of casos) {
        expect(
          await invalidRuleProps({ rules: [{ ...VALID_RULE, startTime }] }),
        ).toContain('startTime');
      }
    });

    it('rechaza una duración de turno fuera del catálogo', async () => {
      for (const slotDurationMinutes of [10, 20, 25, 90, 0]) {
        expect(
          await invalidRuleProps({
            rules: [{ ...VALID_RULE, slotDurationMinutes }],
          }),
        ).toContain('slotDurationMinutes');
      }
    });

    it('acepta las cuatro duraciones del criterio de aceptación', async () => {
      const rules = [15, 30, 45, 60].map((slotDurationMinutes, i) => ({
        ...VALID_RULE,
        weekday: i,
        slotDurationMinutes,
      }));

      expect(await invalidRuleProps({ rules })).toHaveLength(0);
    });
  });
});

describe('CreateScheduleBlockDto (ENG-53)', () => {
  it('acepta solo la fecha — bloqueo de día completo', async () => {
    expect(
      await invalidProps(CreateScheduleBlockDto, { blockDate: '2026-09-01' }),
    ).toHaveLength(0);
  });

  it('acepta fecha con rango horario y motivo', async () => {
    expect(
      await invalidProps(CreateScheduleBlockDto, {
        blockDate: '2026-09-01',
        startTime: '14:00',
        endTime: '16:00',
        reason: 'Congreso',
      }),
    ).toHaveLength(0);
  });

  it('rechaza fechas que no sean AAAA-MM-DD', async () => {
    // El timestamp completo se rechaza a propósito: la columna es `date`, y
    // `@IsDateString()` lo dejaría pasar.
    const casos = ['01/09/2026', '2026-9-1', '2026-13-01', '2026-09-32', ''];

    for (const blockDate of casos) {
      expect(
        await invalidProps(CreateScheduleBlockDto, { blockDate }),
      ).toContain('blockDate');
    }
  });

  it('rechaza un motivo de más de 200 caracteres', async () => {
    expect(
      await invalidProps(CreateScheduleBlockDto, {
        blockDate: '2026-09-01',
        reason: 'x'.repeat(201),
      }),
    ).toContain('reason');
  });

  it('deja pasar una sola de las dos horas — lo rechaza el service, no el DTO', async () => {
    // La coherencia entre startTime y endTime no se puede expresar con
    // decoradores por campo. Se documenta acá para que quede explícito que el
    // DTO no es la última línea de defensa: lo valida `SchedulesService` y lo
    // respalda el CHECK `schedule_blocks_time_range_check`.
    expect(
      await invalidProps(CreateScheduleBlockDto, {
        blockDate: '2026-09-01',
        startTime: '14:00',
      }),
    ).toHaveLength(0);
  });
});
