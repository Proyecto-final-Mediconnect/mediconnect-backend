import { Matches } from 'class-validator';
import { HHMM } from '../../schedules/dto/save-schedule.dto';
import { YYYY_MM_DD } from './availability-query.dto';

/**
 * Cuerpo de `PATCH /appointments/:id/reschedule` (ENG-66): el horario nuevo.
 *
 * No lleva profesional: un turno se reprograma con el mismo. Para cambiar de
 * profesional se cancela y se reserva otro.
 */
export class RescheduleAppointmentDto {
  @Matches(YYYY_MM_DD, { message: 'La fecha debe tener formato AAAA-MM-DD' })
  date!: string;

  @Matches(HHMM, { message: 'La hora debe tener formato HH:MM' })
  startTime!: string;
}
