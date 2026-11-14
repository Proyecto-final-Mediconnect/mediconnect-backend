import { BadRequestException } from '@nestjs/common';
import { currentMonth, lastDays, resolvePeriod } from './period';

describe('período de reporte (ENG-194, ENG-198)', () => {
  const NOW = new Date('2026-11-20T15:00:00.000Z');

  it('las fechas son días de Argentina, inclusivos', () => {
    expect(
      resolvePeriod('2026-11-01', '2026-11-30', currentMonth(NOW)),
    ).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
      start: new Date('2026-11-01T03:00:00.000Z'),
      end: new Date('2026-12-01T03:00:00.000Z'),
    });
  });

  it('lo que falta sale del período por defecto', () => {
    expect(currentMonth(NOW)).toEqual({ from: '2026-11-01', to: '2026-11-20' });
    expect(lastDays(30, NOW)).toEqual({ from: '2026-10-22', to: '2026-11-20' });
    expect(resolvePeriod(undefined, '2026-11-10', currentMonth(NOW)).from).toBe(
      '2026-11-01',
    );
  });

  it('rechaza un período al revés o de más de un año', () => {
    expect(() =>
      resolvePeriod('2026-11-30', '2026-11-01', currentMonth(NOW)),
    ).toThrow(BadRequestException);
    expect(() =>
      resolvePeriod('2025-01-01', '2026-11-01', currentMonth(NOW)),
    ).toThrow(BadRequestException);
  });
});
