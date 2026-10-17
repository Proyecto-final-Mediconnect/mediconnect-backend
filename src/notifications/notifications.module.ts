import { Module } from '@nestjs/common';
import { AppointmentNotificationsService } from './appointment-notifications.service';
import { EmailService } from './email.service';

/**
 * EP-08 — Comunicación.
 *
 * Por ahora solo los emails de turno (ENG-68). Lo importan PaymentsModule (el
 * webhook manda la confirmación al confirmar) y JobsModule (recordatorios). No
 * importa a ninguno de los dos, así que no hay ciclo.
 */
@Module({
  providers: [EmailService, AppointmentNotificationsService],
  exports: [AppointmentNotificationsService],
})
export class NotificationsModule {}
