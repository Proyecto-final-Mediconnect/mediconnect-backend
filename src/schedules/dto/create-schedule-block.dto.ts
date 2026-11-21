import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
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

  /**
   * ENG-206: el profesional confirma que el bloqueo cancela los turnos que pisa.
   * Sin esto, un bloqueo con turnos tomados da 409 con la lista: nunca se
   * cancela un turno sin que el profesional lo haya visto antes.
   */
  @IsOptional()
  @IsBoolean({ message: 'cancelAffected tiene que ser verdadero o falso.' })
  cancelAffected?: boolean;

  /**
   * El motivo que ven los pacientes de los turnos cancelados (ADR-018, caso 1).
   * Distinto de `reason`, que es una nota del profesional para su agenda.
   * Obligatorio si el bloqueo cancela turnos.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(10, 500, {
    message:
      'El motivo para los pacientes tiene que tener entre 10 y 500 caracteres.',
  })
  cancellationReason?: string;
}
