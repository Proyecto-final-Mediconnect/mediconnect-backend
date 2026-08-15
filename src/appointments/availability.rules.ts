import { addDays, toInstant, weekdayOf } from '../common/time/argentina-time';

/**
 * Cálculo de disponibilidad (ENG-54), como funciones puras: no tocan la base ni
 * Nest, así que se testean sin levantar nada.
 *
 * **Esta es la versión autoritativa.** La web tiene su propia generación de slots
 * (`generateSlots.ts`, ENG-53) para la vista previa de la agenda del profesional,
 * pero eso es una previsualización de lo que el profesional está por guardar. Lo
 * que un paciente puede reservar no puede depender de lo que calcule su propio
 * navegador: el front puede estar desactualizado, o manipulado. El servidor
 * recalcula todo y la reserva se valida contra este módulo, no contra lo que
 * mandó el cliente.
 *
 * Toda la aritmética de horas es en **minutos desde la medianoche**, igual que
 * `schedule.rules.ts` de ENG-53: comparar `"09:00"` con `"14:30"` como strings
 * funciona de casualidad con ceros a la izquierda y se rompe apenas cambia el
 * formato.
 */

/** Estado de un horario en la grilla que ve el paciente. */
export type SlotStatus = 'AVAILABLE' | 'BOOKED' | 'BLOCKED' | 'PAST';

/** Franja semanal de atención, tal como la guardó ENG-53. */
export interface AvailabilityRule {
  weekday: number;
  /** `HH:MM` */
  startTime: string;
  /** `HH:MM` */
  endTime: string;
  slotDurationMinutes: number;
}

/** Bloqueo puntual. `startTime`/`endTime` en null = el día completo. */
export interface AvailabilityBlock {
  /** `YYYY-MM-DD` */
  blockDate: string;
  startTime: string | null;
  endTime: string | null;
}

/** Turno ya tomado que ocupa el horario (RESERVADO_SIN_PAGAR o CONFIRMADO). */
export interface BusySlot {
  scheduledAt: Date;
  durationMinutes: number;
}

export interface AvailabilitySlot {
  /** `HH:MM`, hora local de Argentina. */
  startTime: string;
  durationMinutes: number;
  status: SlotStatus;
}

export interface AvailabilityDay {
  /** `YYYY-MM-DD` */
  date: string;
  weekday: number;
  /** Hay un bloqueo de día completo: el profesional no atiende ese día. */
  fullyBlocked: boolean;
  slots: AvailabilitySlot[];
}

/** `"HH:MM"` → minutos desde medianoche. */
export function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Minutos desde medianoche → `"HH:MM"`. */
export function toTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Horas de inicio que genera una franja.
 *
 * `+ step <= end`: un turno que no entra completo en la franja no se ofrece. Con
 * 09:00-10:20 y turnos de 30 salen 09:00 y 09:30, no un 10:00 que terminaría
 * fuera del horario de atención.
 */
export function slotsForRule(rule: AvailabilityRule): string[] {
  const start = toMinutes(rule.startTime);
  const end = toMinutes(rule.endTime);
  const step = rule.slotDurationMinutes;

  if (step <= 0 || end <= start) return [];

  const slots: string[] = [];
  for (let t = start; t + step <= end; t += step) {
    slots.push(toTime(t));
  }
  return slots;
}

/** Un bloqueo sin horas tapa el día entero. */
function isFullDay(block: AvailabilityBlock): boolean {
  return block.startTime === null || block.endTime === null;
}

/** ¿`[startA, endA)` y `[startB, endB)` se pisan? Tocarse en el borde no cuenta. */
function overlaps(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean {
  return startA < endB && startB < endA;
}

export interface BuildAvailabilityInput {
  rules: AvailabilityRule[];
  blocks: AvailabilityBlock[];
  busy: BusySlot[];
  /** `YYYY-MM-DD` inclusive. */
  from: string;
  /** `YYYY-MM-DD` inclusive. */
  to: string;
  /** Momento actual; parámetro y no `new Date()` adentro para poder testear. */
  now: Date;
}

/**
 * Arma la grilla de `from` a `to` (ambos inclusive) aplicando franjas, bloqueos y
 * turnos ya tomados.
 *
 * **Los horarios no disponibles no se omiten: se devuelven marcados.** El criterio
 * de aceptación pide que "disponibles, ocupados y bloqueados" se distingan
 * visualmente, y un hueco vacío no comunica lo mismo que un horario tachado: el
 * paciente que ve 09:00 ocupado y 09:30 libre entiende que el profesional atiende
 * a esa hora y que ese turno ya se lo llevaron.
 *
 * Prioridad cuando un horario cae en más de una categoría:
 * `BOOKED` > `BLOCKED` > `PAST` > `AVAILABLE`. Ocupado gana porque es el estado
 * más informativo (alguien lo reservó) y porque un turno reservado sobre un rato
 * que después se bloqueó sigue existiendo: el paciente lo tiene que ver.
 */
export function buildAvailability({
  rules,
  blocks,
  busy,
  from,
  to,
  now,
}: BuildAvailabilityInput): AvailabilityDay[] {
  const days: AvailabilityDay[] = [];

  // Los turnos tomados se indexan por instante: comparar milisegundos evita
  // reconstruir el string de hora local para cada slot de cada día.
  const busyByInstant = new Map<number, BusySlot>();
  for (const slot of busy) {
    busyByInstant.set(slot.scheduledAt.getTime(), slot);
  }

  for (let date = from; date <= to; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    const dayBlocks = blocks.filter((block) => block.blockDate === date);
    const fullyBlocked = dayBlocks.some(isFullDay);

    const slots = rules
      .filter((rule) => rule.weekday === weekday)
      .flatMap((rule) =>
        slotsForRule(rule).map((startTime) => ({
          startTime,
          durationMinutes: rule.slotDurationMinutes,
        })),
      )
      // Varias franjas del mismo día (mañana y tarde) se cargan en el orden en
      // que el profesional las guardó; se ordena por hora para que el día se lea
      // como un día.
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .map(({ startTime, durationMinutes }) => ({
        startTime,
        durationMinutes,
        status: statusOf({
          date,
          startTime,
          durationMinutes,
          dayBlocks,
          fullyBlocked,
          busyByInstant,
          now,
        }),
      }));

    days.push({ date, weekday, fullyBlocked, slots });
  }

  return days;
}

function statusOf({
  date,
  startTime,
  durationMinutes,
  dayBlocks,
  fullyBlocked,
  busyByInstant,
  now,
}: {
  date: string;
  startTime: string;
  durationMinutes: number;
  dayBlocks: AvailabilityBlock[];
  fullyBlocked: boolean;
  busyByInstant: Map<number, BusySlot>;
  now: Date;
}): SlotStatus {
  const instant = toInstant(date, startTime);

  if (busyByInstant.has(instant.getTime())) return 'BOOKED';
  if (fullyBlocked) return 'BLOCKED';

  const start = toMinutes(startTime);
  const end = start + durationMinutes;
  const hitsBlock = dayBlocks.some(
    (block) =>
      !isFullDay(block) &&
      overlaps(
        start,
        end,
        toMinutes(block.startTime!),
        toMinutes(block.endTime!),
      ),
  );
  if (hitsBlock) return 'BLOCKED';

  // `PAST` no es un estado del dominio: es el reloj. Se distingue de `BLOCKED`
  // porque no dice nada del profesional — el horario de las 09:00 de hoy no está
  // "bloqueado", simplemente ya pasó.
  if (instant.getTime() <= now.getTime()) return 'PAST';

  return 'AVAILABLE';
}

/** Busca un horario concreto dentro de la grilla ya calculada. */
export function findSlot(
  days: AvailabilityDay[],
  date: string,
  startTime: string,
): AvailabilitySlot | null {
  const day = days.find((d) => d.date === date);
  return day?.slots.find((slot) => slot.startTime === startTime) ?? null;
}
