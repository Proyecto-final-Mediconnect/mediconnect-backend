import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { HHMM } from './save-schedule.dto';

/** `YYYY-MM-DD`. Se usa un patrón explícito en vez de `@IsDateString()` porque
 *  este último acepta timestamps completos con zona, y la columna es `date`. */
const YYYY_MM_DD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Bloqueo puntual: un feriado, una licencia o un rato del día que el profesional
 * no atiende (ENG-53).
 *
 * `startTime` y `endTime` van juntos o no van: omitirlos bloquea **el día
 * completo**; con valor, bloquean solo esa franja. El estado intermedio (una sola
 * de las dos) lo rechaza el service, y el CHECK
 * `schedule_blocks_time_range_check` lo respalda en la base.
 */
export class CreateScheduleBlockDto {
  @Matches(YYYY_MM_DD, { message: 'La fecha debe tener formato AAAA-MM-DD' })
  blockDate!: string;

  @IsOptional()
  @Matches(HHMM, { message: 'La hora de inicio debe tener formato HH:MM' })
  startTime?: string;

  @IsOptional()
  @Matches(HHMM, { message: 'La hora de fin debe tener formato HH:MM' })
  endTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'El motivo no puede superar los 200 caracteres' })
  reason?: string;
}
