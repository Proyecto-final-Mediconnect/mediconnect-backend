/**
 * Fechas y horas en hora de Argentina (ENG-54).
 *
 * El backend corre en Render, en UTC. La agenda del profesional, en cambio, se
 * define en hora local: `schedule_rules.start_time` es un `time` sin zona y
 * "atiendo de 9 a 13" significa 9 a 13 **acá**. Mezclar las dos cosas produce
 * errores que solo se ven en ciertas horas del día — entre las 21:00 y la
 * medianoche de Argentina, la fecha UTC ya es la de mañana — así que la conversión
 * se hace en un solo lugar y no en cada consulta.
 *
 * La zona está fija porque el MVP es solo Argentina, misma premisa que
 * `currency = 'ARS'` en el modelo de datos. Cuando haya profesionales en otra
 * zona, esto pasa a salir del perfil del profesional y estas funciones toman la
 * zona como parámetro.
 */

const AR_TIMEZONE = 'America/Argentina/Buenos_Aires';

/**
 * Offset fijo de Argentina respecto de UTC.
 *
 * Argentina **no aplica horario de verano** desde 2009, así que el offset es
 * constante y se puede usar como sufijo en un string ISO. Si algún día volviera el
 * DST, esta constante deja de alcanzar y hay que resolver el offset por fecha con
 * `Intl` — está acá, sola y comentada, justamente para que ese cambio sea de una
 * línea y no una cacería.
 */
export const AR_UTC_OFFSET = '-03:00';

/**
 * Se arma con `formatToParts` en vez de confiar en que un locale imprima
 * `YYYY-MM-DD`: si Node se compila sin ICU completo, `en-CA` cae a `en-US` y pasa
 * a devolver `MM/DD/YYYY`. La comparación seguiría corriendo, pero contra basura
 * — el tipo de falla que no se ve hasta que alguien nota que faltan días.
 */
const AR_DATE_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: AR_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Fecha de hoy en Argentina, en `YYYY-MM-DD`. */
export function todayInArgentina(now: Date = new Date()): string {
  const parts = Object.fromEntries(
    AR_DATE_PARTS.formatToParts(now).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * `('2026-08-17', '09:00')` → el instante UTC que corresponde a las 09:00 de ese
 * día en Argentina. Es la conversión que va a `appointments.scheduled_at`
 * (`timestamptz`).
 */
export function toInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00${AR_UTC_OFFSET}`);
}

/**
 * El camino inverso a `toInstant`: un instante UTC → la fecha y la hora que ese
 * instante tiene en Argentina. Es lo que necesita la API para devolver un turno
 * en los mismos términos en que el paciente lo reservó ("el martes a las 09:00")
 * y no en UTC, donde figuraría a las 12:00.
 */
export function toLocalDateTime(instant: Date): {
  date: string;
  startTime: string;
} {
  const parts = Object.fromEntries(
    AR_DATE_TIME_PARTS.formatToParts(instant).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // `hourCycle: 'h23'` para que la medianoche salga como `00` y no como `24`,
    // que es lo que devuelve `hour12: false` en varias versiones de ICU.
    startTime: `${parts.hour}:${parts.minute}`,
  };
}

const AR_DATE_TIME_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: AR_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `YYYY-MM-DD` sumándole días, sin pasar por husos horarios: las fechas de la
 *  agenda son etiquetas de calendario, no instantes. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Días de diferencia entre dos fechas `YYYY-MM-DD` (`to - from`). */
export function daysBetween(from: string, to: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      MS_PER_DAY,
  );
}

/** Día de la semana (0 = domingo, igual que `Date.getDay()` y que el CHECK de
 *  `schedule_rules.weekday`) de una fecha `YYYY-MM-DD`. */
export function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
