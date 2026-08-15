import {
  buildAvailability,
  findSlot,
  slotsForRule,
  toMinutes,
  toTime,
  type AvailabilityBlock,
  type AvailabilityRule,
} from './availability.rules';
import { toInstant } from '../common/time/argentina-time';

/** Lunes 17/08/2026, para que `weekday` sea 1 y los casos se lean solos. */
const MONDAY = '2026-08-17';
const TUESDAY = '2026-08-18';

/** Un momento bien anterior a la grilla: nada cae en el pasado salvo que se diga. */
const BEFORE = new Date('2026-08-16T12:00:00Z');

const MORNING: AvailabilityRule = {
  weekday: 1,
  startTime: '09:00',
  endTime: '11:00',
  slotDurationMinutes: 30,
};

function build(overrides: {
  rules?: AvailabilityRule[];
  blocks?: AvailabilityBlock[];
  busy?: { scheduledAt: Date; durationMinutes: number }[];
  from?: string;
  to?: string;
  now?: Date;
}) {
  return buildAvailability({
    rules: overrides.rules ?? [MORNING],
    blocks: overrides.blocks ?? [],
    busy: overrides.busy ?? [],
    from: overrides.from ?? MONDAY,
    to: overrides.to ?? MONDAY,
    now: overrides.now ?? BEFORE,
  });
}

describe('conversión de horas', () => {
  it('va y vuelve entre HH:MM y minutos', () => {
    expect(toMinutes('09:30')).toBe(570);
    expect(toTime(570)).toBe('09:30');
    expect(toTime(0)).toBe('00:00');
  });
});

describe('slotsForRule', () => {
  it('genera un turno por cada duración que entre completa', () => {
    expect(slotsForRule(MORNING)).toEqual(['09:00', '09:30', '10:00', '10:30']);
  });

  it('descarta el turno que se pasaría del horario de atención', () => {
    // 09:00-10:20 con turnos de 30: el de las 10:00 terminaría 10:30, afuera.
    expect(slotsForRule({ ...MORNING, endTime: '10:20' })).toEqual([
      '09:00',
      '09:30',
    ]);
  });

  it('devuelve vacío si la franja es más corta que un turno', () => {
    expect(slotsForRule({ ...MORNING, endTime: '09:15' })).toEqual([]);
  });

  it('devuelve vacío si la franja está invertida o la duración es 0', () => {
    expect(slotsForRule({ ...MORNING, endTime: '08:00' })).toEqual([]);
    expect(slotsForRule({ ...MORNING, slotDurationMinutes: 0 })).toEqual([]);
  });
});

describe('buildAvailability', () => {
  it('marca todos los horarios de la franja como disponibles', () => {
    const [day] = build({});

    expect(day.date).toBe(MONDAY);
    expect(day.weekday).toBe(1);
    expect(day.fullyBlocked).toBe(false);
    expect(day.slots.map((s) => s.startTime)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
    ]);
    expect(day.slots.every((s) => s.status === 'AVAILABLE')).toBe(true);
  });

  it('un día sin franja para ese weekday queda sin horarios', () => {
    const [day] = build({ from: TUESDAY, to: TUESDAY });

    expect(day.slots).toEqual([]);
  });

  it('ordena por hora aunque las franjas se hayan cargado al revés', () => {
    const afternoon: AvailabilityRule = {
      weekday: 1,
      startTime: '14:00',
      endTime: '15:00',
      slotDurationMinutes: 60,
    };
    const [day] = build({ rules: [afternoon, MORNING] });

    expect(day.slots.map((s) => s.startTime)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '14:00',
    ]);
  });

  it('marca ocupado el horario que ya tiene un turno', () => {
    const [day] = build({
      busy: [{ scheduledAt: toInstant(MONDAY, '09:30'), durationMinutes: 30 }],
    });

    expect(findSlot([day], MONDAY, '09:30')?.status).toBe('BOOKED');
    // Los de al lado siguen libres: no se pierde media mañana por un turno.
    expect(findSlot([day], MONDAY, '09:00')?.status).toBe('AVAILABLE');
    expect(findSlot([day], MONDAY, '10:00')?.status).toBe('AVAILABLE');
  });

  it('un bloqueo de día completo marca todo bloqueado, no vacío', () => {
    // El criterio de aceptación pide que "bloqueado" se distinga visualmente: un
    // día sin horarios no comunica lo mismo que un día con todo tachado.
    const [day] = build({
      blocks: [{ blockDate: MONDAY, startTime: null, endTime: null }],
    });

    expect(day.fullyBlocked).toBe(true);
    expect(day.slots).toHaveLength(4);
    expect(day.slots.every((s) => s.status === 'BLOCKED')).toBe(true);
  });

  it('un bloqueo parcial solo tapa los horarios que pisa', () => {
    const [day] = build({
      blocks: [{ blockDate: MONDAY, startTime: '09:45', endTime: '10:15' }],
    });

    expect(findSlot([day], MONDAY, '09:00')?.status).toBe('AVAILABLE');
    // 09:30-10:00 pisa el arranque del bloqueo.
    expect(findSlot([day], MONDAY, '09:30')?.status).toBe('BLOCKED');
    // 10:00-10:30 pisa el final.
    expect(findSlot([day], MONDAY, '10:00')?.status).toBe('BLOCKED');
    expect(findSlot([day], MONDAY, '10:30')?.status).toBe('AVAILABLE');
  });

  it('un bloqueo que solo toca el borde no bloquea', () => {
    // 09:00-09:30 y un bloqueo 09:30-10:00 son contiguos, no solapados.
    const [day] = build({
      blocks: [{ blockDate: MONDAY, startTime: '09:30', endTime: '10:00' }],
    });

    expect(findSlot([day], MONDAY, '09:00')?.status).toBe('AVAILABLE');
    expect(findSlot([day], MONDAY, '09:30')?.status).toBe('BLOCKED');
  });

  it('el bloqueo de otro día no afecta', () => {
    const [day] = build({
      blocks: [{ blockDate: TUESDAY, startTime: null, endTime: null }],
    });

    expect(day.slots.every((s) => s.status === 'AVAILABLE')).toBe(true);
  });

  it('ocupado le gana a bloqueado', () => {
    // Un turno reservado sobre un rato que después se bloqueó sigue existiendo:
    // el paciente que lo tiene tiene que verlo.
    const [day] = build({
      blocks: [{ blockDate: MONDAY, startTime: null, endTime: null }],
      busy: [{ scheduledAt: toInstant(MONDAY, '09:00'), durationMinutes: 30 }],
    });

    expect(findSlot([day], MONDAY, '09:00')?.status).toBe('BOOKED');
    expect(findSlot([day], MONDAY, '09:30')?.status).toBe('BLOCKED');
  });

  it('marca como pasados los horarios ya transcurridos de hoy', () => {
    // 09:45 hora de Argentina = 12:45 UTC.
    const now = new Date('2026-08-17T12:45:00Z');
    const [day] = build({ now });

    expect(findSlot([day], MONDAY, '09:00')?.status).toBe('PAST');
    expect(findSlot([day], MONDAY, '09:30')?.status).toBe('PAST');
    expect(findSlot([day], MONDAY, '10:00')?.status).toBe('AVAILABLE');
  });

  it('el horario que arranca justo ahora ya no se puede reservar', () => {
    const now = toInstant(MONDAY, '09:30');
    const [day] = build({ now });

    expect(findSlot([day], MONDAY, '09:30')?.status).toBe('PAST');
    expect(findSlot([day], MONDAY, '10:00')?.status).toBe('AVAILABLE');
  });

  it('recorre el rango completo, día por día', () => {
    const days = build({ from: MONDAY, to: '2026-08-23' });

    expect(days).toHaveLength(7);
    expect(days.map((d) => d.date)).toEqual([
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
    ]);
    expect(days.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it('cruza el fin de mes sin saltearse días', () => {
    const days = build({ from: '2026-08-30', to: '2026-09-02' });

    expect(days.map((d) => d.date)).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
  });
});

describe('findSlot', () => {
  it('devuelve null si el día o el horario no están en la grilla', () => {
    const days = build({});

    expect(findSlot(days, TUESDAY, '09:00')).toBeNull();
    expect(findSlot(days, MONDAY, '09:15')).toBeNull();
  });
});
