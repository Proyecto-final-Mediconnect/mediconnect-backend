/**
 * Reglas de negocio de la agenda (ENG-53), como funciones puras: no tocan la base
 * ni Nest, así que se testean sin levantar nada.
 *
 * Todo el módulo razona en **minutos desde la medianoche**. Comparar `"09:00"` con
 * `"14:30"` como strings funciona de casualidad con ceros a la izquierda y se
 * rompe apenas aparece un formato distinto; los enteros no tienen esa trampa y
 * hacen que la aritmética de duración sea directa.
 */

/** `"HH:MM"` → minutos desde medianoche. Asume el formato ya validado por el DTO. */
export function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Normaliza a `HH:MM:SS`, que es como Postgres almacena `time`. */
export function toSqlTime(time: string): string {
  return `${time}:00`;
}

/** `HH:MM:SS` (lo que devuelve PostgREST) → `HH:MM` para la API. */
export function fromSqlTime(time: string): string {
  return time.slice(0, 5);
}

/** Franja horaria genérica, en el formato `HH:MM` de la API. */
export interface TimeWindow {
  startTime: string;
  endTime: string;
}

/**
 * Valida una ventana horaria suelta. Devuelve el mensaje de error o `null`.
 *
 * `slotDurationMinutes` es opcional porque los bloqueos no generan turnos: para
 * ellos alcanza con que la ventana tenga duración positiva.
 */
export function validateWindow(
  window: TimeWindow,
  slotDurationMinutes?: number,
): string | null {
  const start = toMinutes(window.startTime);
  const end = toMinutes(window.endTime);

  if (end <= start) {
    return `La hora de fin (${window.endTime}) debe ser posterior a la de inicio (${window.startTime}).`;
  }

  // Una franja más corta que un turno no genera ninguno: se guardaría una regla
  // que al profesional le parece disponibilidad y al paciente no le ofrece nada.
  // Mejor rechazarla acá que dejar la agenda en un estado silenciosamente inútil.
  if (slotDurationMinutes !== undefined && end - start < slotDurationMinutes) {
    return `La franja de ${window.startTime} a ${window.endTime} es más corta que la duración del turno (${slotDurationMinutes} min), así que no genera ningún turno.`;
  }

  return null;
}

/** Dos ventanas se solapan si una empieza antes de que termine la otra. Tocarse
 *  en el borde (09:00-13:00 y 13:00-17:00) NO es solape: son contiguas. */
function overlaps(a: TimeWindow, b: TimeWindow): boolean {
  return (
    toMinutes(a.startTime) < toMinutes(b.endTime) &&
    toMinutes(b.startTime) < toMinutes(a.endTime)
  );
}

/** Regla de agenda tal como la manda el cliente. */
export interface WeeklyRule extends TimeWindow {
  weekday: number;
  slotDurationMinutes: number;
}

/**
 * Busca el primer par de franjas solapadas **dentro del mismo día**. Franjas de
 * días distintos nunca chocan, aunque compartan horario.
 *
 * La base no puede hacer esta validación con un unique: no hay unique que exprese
 * "rangos que no se pisen". Un constraint EXCLUDE de Postgres podría, pero
 * requiere la extensión btree_gist y complica la migración para un caso que el
 * service resuelve en dos líneas.
 */
export function findOverlappingRules(
  rules: WeeklyRule[],
): [WeeklyRule, WeeklyRule] | null {
  const byWeekday = new Map<number, WeeklyRule[]>();

  for (const rule of rules) {
    const sameDay = byWeekday.get(rule.weekday) ?? [];
    for (const previous of sameDay) {
      if (overlaps(previous, rule)) return [previous, rule];
    }
    sameDay.push(rule);
    byWeekday.set(rule.weekday, sameDay);
  }

  return null;
}

/** Nombres de día para los mensajes de error, indexados por `weekday` (0 = domingo). */
export const WEEKDAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;
