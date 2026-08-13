import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** `HH:MM` en 24 h. Las columnas son `time` de Postgres (sin zona): la agenda se
 *  define en hora local del profesional, no en UTC. */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Duraciones admitidas, iguales al CHECK `schedule_rules_slot_duration_check`. */
export const SLOT_DURATIONS = [15, 30, 45, 60] as const;

/**
 * Máximo de franjas por semana. 7 días × 4 franjas diarias es holgado para el
 * caso real (mañana/tarde) y acota el payload: sin tope, un `PUT` podría mandar
 * miles de filas para insertar de una.
 */
export const MAX_RULES = 28;

/** Una franja de atención. Un mismo `weekday` puede tener varias (turno mañana y
 *  turno tarde); el solape entre ellas lo valida el service. */
export class ScheduleRuleDto {
  /** 0 = domingo … 6 = sábado, igual que `Date.getDay()` y que el CHECK de la BD. */
  @IsInt({ message: 'El día de la semana debe ser un número entero' })
  @Min(0, {
    message: 'El día de la semana debe estar entre 0 (domingo) y 6 (sábado)',
  })
  @Max(6, {
    message: 'El día de la semana debe estar entre 0 (domingo) y 6 (sábado)',
  })
  weekday!: number;

  @Matches(HHMM, { message: 'La hora de inicio debe tener formato HH:MM' })
  startTime!: string;

  @Matches(HHMM, { message: 'La hora de fin debe tener formato HH:MM' })
  endTime!: string;

  @IsIn(SLOT_DURATIONS, {
    message: 'La duración del turno debe ser 15, 30, 45 o 60 minutos',
  })
  slotDurationMinutes!: number;
}

/**
 * Agenda semanal completa (ENG-53). El `PUT` reemplaza **todo** el set de reglas:
 * mandar `rules: []` es la forma de dejar la agenda vacía (el profesional deja de
 * publicar disponibilidad), no un error.
 */
export class SaveScheduleDto {
  @IsArray({ message: 'Las reglas de agenda deben venir en una lista' })
  @ArrayMaxSize(MAX_RULES, {
    message: `No se pueden definir más de ${MAX_RULES} franjas por semana`,
  })
  @ValidateNested({ each: true })
  @Type(() => ScheduleRuleDto)
  rules!: ScheduleRuleDto[];
}
