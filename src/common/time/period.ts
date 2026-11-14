import { BadRequestException } from '@nestjs/common';
import { addDays, toInstant, todayInArgentina } from './argentina-time';

/** Tope de un período: un año alcanza para cualquier reporte y acota la consulta. */
export const MAX_PERIOD_DAYS = 366;

/**
 * Un período de reporte en fechas de Argentina (ENG-194, ENG-198).
 *
 * `from` y `to` son días locales e **inclusivos** ("del 1 al 30 de noviembre").
 * `start` y `end` son los instantes UTC para filtrar `timestamptz`: `end` es el
 * comienzo del día siguiente a `to`, exclusivo, así un pago de las 23:59 del
 * 30 entra y uno de las 00:00 del 1 de diciembre no.
 */
export interface ReportPeriod {
  from: string;
  to: string;
  start: Date;
  end: Date;
}

/** El mes en curso en Argentina: del 1 a hoy. */
export function currentMonth(now: Date = new Date()): {
  from: string;
  to: string;
} {
  const hoy = todayInArgentina(now);
  return { from: `${hoy.slice(0, 7)}-01`, to: hoy };
}

/** Los últimos `days` días en Argentina, hoy incluido. */
export function lastDays(
  days: number,
  now: Date = new Date(),
): { from: string; to: string } {
  const hoy = todayInArgentina(now);
  return { from: addDays(hoy, -(days - 1)), to: hoy };
}

/**
 * Arma el período a partir de `?from&to`, con `fallback` para lo que falte.
 * El formato `YYYY-MM-DD` ya lo valida el DTO; acá se valida el orden y el tope.
 */
export function resolvePeriod(
  from: string | undefined,
  to: string | undefined,
  fallback: { from: string; to: string },
): ReportPeriod {
  const desde = from ?? fallback.from;
  const hasta = to ?? fallback.to;
  if (desde > hasta) {
    throw new BadRequestException(
      'La fecha "desde" no puede ser posterior a "hasta".',
    );
  }
  const start = toInstant(desde, '00:00');
  const end = toInstant(addDays(hasta, 1), '00:00');
  if (end.getTime() - start.getTime() > MAX_PERIOD_DAYS * 86_400_000) {
    throw new BadRequestException(
      `El período no puede pasar los ${MAX_PERIOD_DAYS} días.`,
    );
  }
  return { from: desde, to: hasta, start, end };
}
