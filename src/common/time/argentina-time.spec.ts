import {
  addDays,
  daysBetween,
  toInstant,
  toLocalDateTime,
  todayInArgentina,
  weekdayOf,
} from './argentina-time';

describe('argentina-time', () => {
  describe('todayInArgentina', () => {
    it('devuelve el día local, no el UTC, después de las 21:00', () => {
      // 2026-08-17 23:30 en Argentina = 2026-08-18 02:30 UTC. El backend corre en
      // UTC: sin esta conversión, entre las 21:00 y la medianoche todo el sistema
      // creería que ya es mañana.
      expect(todayInArgentina(new Date('2026-08-18T02:30:00Z'))).toBe(
        '2026-08-17',
      );
    });

    it('devuelve el día correcto a media mañana', () => {
      expect(todayInArgentina(new Date('2026-08-17T13:00:00Z'))).toBe(
        '2026-08-17',
      );
    });
  });

  describe('toInstant', () => {
    it('interpreta la hora como local de Argentina (UTC-3)', () => {
      expect(toInstant('2026-08-17', '09:00').toISOString()).toBe(
        '2026-08-17T12:00:00.000Z',
      );
    });

    it('la medianoche local cae en el día siguiente en UTC', () => {
      expect(toInstant('2026-08-17', '23:30').toISOString()).toBe(
        '2026-08-18T02:30:00.000Z',
      );
    });
  });

  describe('toLocalDateTime', () => {
    it('es el inverso de toInstant', () => {
      const instant = toInstant('2026-08-17', '09:30');

      expect(toLocalDateTime(instant)).toEqual({
        date: '2026-08-17',
        startTime: '09:30',
      });
    });

    it('devuelve la medianoche como 00:00 y no como 24:00', () => {
      expect(toLocalDateTime(toInstant('2026-08-17', '00:00'))).toEqual({
        date: '2026-08-17',
        startTime: '00:00',
      });
    });

    it('un instante nocturno en UTC vuelve al día local correcto', () => {
      expect(toLocalDateTime(new Date('2026-08-18T02:30:00Z'))).toEqual({
        date: '2026-08-17',
        startTime: '23:30',
      });
    });
  });

  describe('addDays', () => {
    it('cruza el fin de mes', () => {
      expect(addDays('2026-08-30', 3)).toBe('2026-09-02');
    });

    it('cruza el fin de año hacia atrás', () => {
      expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    });

    it('respeta el año bisiesto', () => {
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    });
  });

  describe('daysBetween', () => {
    it('cuenta la diferencia en días', () => {
      expect(daysBetween('2026-08-17', '2026-08-23')).toBe(6);
      expect(daysBetween('2026-08-17', '2026-08-17')).toBe(0);
      expect(daysBetween('2026-08-23', '2026-08-17')).toBe(-6);
    });
  });

  describe('weekdayOf', () => {
    it('usa la convención 0 = domingo, igual que schedule_rules', () => {
      expect(weekdayOf('2026-08-16')).toBe(0); // domingo
      expect(weekdayOf('2026-08-17')).toBe(1); // lunes
      expect(weekdayOf('2026-08-22')).toBe(6); // sábado
    });
  });
});
