import { addDays, toInstant } from '../common/time/argentina-time';

/**
 * Qué turnos pisa un bloqueo de agenda (ENG-206). Lógica pura, sin base.
 *
 * Un bloqueo es un día completo o una franja de un día, en hora de Argentina.
 * Un turno lo pisa si **se superpone** con esa ventana, aunque sea en parte: un
 * turno de 10:45 a 11:15 queda adentro de un bloqueo de 11:00 a 12:00, porque
 * el profesional no va a estar para terminarlo.
 */

export interface BlockWindow {
  /** Instante (UTC) en que empieza el bloqueo. */
  start: Date;
  /** Instante (UTC) en que termina, exclusivo. */
  end: Date;
}

/** Ventana del bloqueo en instantes. Sin horas, el día completo. */
export function blockWindow(
  blockDate: string,
  startTime?: string,
  endTime?: string,
): BlockWindow {
  if (startTime && endTime) {
    return {
      start: toInstant(blockDate, startTime),
      end: toInstant(blockDate, endTime),
    };
  }
  return {
    start: toInstant(blockDate, '00:00'),
    end: toInstant(addDays(blockDate, 1), '00:00'),
  };
}

/** Si el turno `[scheduledAt, scheduledAt + duración)` se superpone con la ventana. */
export function overlaps(
  window: BlockWindow,
  scheduledAt: Date,
  durationMinutes: number,
): boolean {
  const end = scheduledAt.getTime() + durationMinutes * 60_000;
  return scheduledAt < window.end && end > window.start.getTime();
}

/** Si dos bloqueos del mismo día se superponen. `null` = día completo. */
export function blocksOverlap(
  a: { startTime: string | null; endTime: string | null },
  b: { startTime: string | null; endTime: string | null },
): boolean {
  if (!a.startTime || !a.endTime || !b.startTime || !b.endTime) return true;
  return a.startTime < b.endTime && b.startTime < a.endTime;
}

/**
 * Cuánto antes del bloqueo puede empezar un turno que igual lo pise. Acota la
 * consulta: ningún turno dura más que esto.
 */
export const MAX_APPOINTMENT_MINUTES = 240;
