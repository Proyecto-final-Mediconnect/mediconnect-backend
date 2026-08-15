import {
  findOverlappingRules,
  fromSqlTime,
  toMinutes,
  toSqlTime,
  validateWindow,
  WeeklyRule,
} from './schedule.rules';

/** Atajo para armar una franja sin repetir la duración en cada caso. */
function rule(
  weekday: number,
  startTime: string,
  endTime: string,
  slotDurationMinutes = 30,
): WeeklyRule {
  return { weekday, startTime, endTime, slotDurationMinutes };
}

describe('schedule.rules (ENG-53)', () => {
  describe('toMinutes', () => {
    it('convierte HH:MM a minutos desde medianoche', () => {
      expect(toMinutes('00:00')).toBe(0);
      expect(toMinutes('09:30')).toBe(570);
      expect(toMinutes('23:59')).toBe(1439);
    });
  });

  describe('toSqlTime / fromSqlTime', () => {
    it('agrega y saca los segundos que usa Postgres', () => {
      expect(toSqlTime('09:00')).toBe('09:00:00');
      expect(fromSqlTime('09:00:00')).toBe('09:00');
    });
  });

  describe('validateWindow', () => {
    it('acepta una ventana que entra justo en un turno', () => {
      expect(validateWindow(rule(1, '09:00', '09:30'), 30)).toBeNull();
    });

    it('rechaza que el fin sea anterior al inicio', () => {
      expect(validateWindow(rule(1, '18:00', '09:00'), 30)).toContain(
        'debe ser posterior',
      );
    });

    it('rechaza una ventana de duración cero', () => {
      expect(validateWindow(rule(1, '09:00', '09:00'), 30)).toContain(
        'debe ser posterior',
      );
    });

    it('rechaza una ventana más corta que la duración del turno', () => {
      // 20 min de ventana con turnos de 30 no genera ningún turno: es agenda
      // que el profesional cree que publicó y el paciente nunca ve.
      expect(validateWindow(rule(1, '09:00', '09:20'), 30)).toContain(
        'no genera ningún turno',
      );
    });

    it('sin duración de turno solo exige duración positiva (caso bloqueo)', () => {
      expect(
        validateWindow({ startTime: '14:00', endTime: '14:10' }),
      ).toBeNull();
    });
  });

  describe('findOverlappingRules', () => {
    it('no marca solape entre franjas del mismo día que no se pisan', () => {
      const rules = [rule(2, '09:00', '13:00'), rule(2, '16:00', '20:00')];

      expect(findOverlappingRules(rules)).toBeNull();
    });

    it('no marca solape entre franjas contiguas (una termina donde arranca la otra)', () => {
      const rules = [rule(2, '09:00', '13:00'), rule(2, '13:00', '17:00')];

      expect(findOverlappingRules(rules)).toBeNull();
    });

    it('no marca solape entre franjas de días distintos con el mismo horario', () => {
      const rules = [rule(1, '09:00', '13:00'), rule(2, '09:00', '13:00')];

      expect(findOverlappingRules(rules)).toBeNull();
    });

    it('detecta el solape parcial dentro del mismo día', () => {
      const rules = [rule(3, '09:00', '13:00'), rule(3, '12:00', '16:00')];

      const overlap = findOverlappingRules(rules);

      expect(overlap).not.toBeNull();
      expect(overlap?.[0].startTime).toBe('09:00');
      expect(overlap?.[1].startTime).toBe('12:00');
    });

    it('detecta una franja contenida dentro de otra', () => {
      const rules = [rule(4, '08:00', '20:00'), rule(4, '10:00', '11:00')];

      expect(findOverlappingRules(rules)).not.toBeNull();
    });

    it('acepta una agenda semanal completa sin solapes', () => {
      const rules = [
        rule(1, '09:00', '13:00'),
        rule(1, '16:00', '20:00'),
        rule(2, '09:00', '13:00'),
        rule(3, '14:00', '18:00'),
        rule(5, '08:00', '12:00'),
      ];

      expect(findOverlappingRules(rules)).toBeNull();
    });
  });
});
