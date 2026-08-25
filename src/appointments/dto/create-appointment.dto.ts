import { IsUUID, Matches } from 'class-validator';
import { HHMM } from '../../schedules/dto/save-schedule.dto';
import { YYYY_MM_DD } from './availability-query.dto';

/**
 * Reserva de un turno (ENG-54).
 *
 * El cliente manda **fecha + hora local**, no un instante ISO con zona. Es
 * deliberado: la agenda del profesional está definida en hora local
 * (`schedule_rules.start_time` es un `time` sin zona) y el horario que el paciente
 * ve y toca en el calendario es "el martes a las 09:00". Si el cliente mandara un
 * instante, cada navegador con un reloj o un huso distinto podría convertirlo
 * distinto y reservar un horario que no es el que vio en pantalla. El backend hace
 * la conversión, una sola vez, en `toInstant`.
 *
 * Lo que NO manda el cliente: el precio, la duración y el estado. Los tres los
 * decide el servidor (precio y duración salen del perfil y de la agenda del
 * profesional; el estado lo pone el DEFAULT de la columna). Aceptarlos del cuerpo
 * dejaría que un paciente se reserve un turno a $0 o ya confirmado sin pagar.
 * `forbidNonWhitelisted` los rechaza si aparecen.
 *
 * Tampoco manda `patientId`: es el `auth.uid()` del JWT, y la política RLS
 * `appointments_insert_own_patient` lo respalda en la base.
 */
export class CreateAppointmentDto {
  @IsUUID('4', { message: 'El identificador del profesional no es válido' })
  professionalId!: string;

  @Matches(YYYY_MM_DD, { message: 'La fecha debe tener formato AAAA-MM-DD' })
  date!: string;

  @Matches(HHMM, { message: 'La hora debe tener formato HH:MM' })
  startTime!: string;
}
