import { Module } from '@nestjs/common';
import { AppointmentNotificationsService } from './appointment-notifications.service';
import { EmailService } from './email.service';
import { InAppNotificationsService } from './in-app-notifications.service';
import { NotificationsController } from './notifications.controller';

/**
 * EP-08 — Comunicación.
 *
 * Los emails de turno (ENG-68) y la bandeja de avisos in-app (ENG-69). Lo
 * importan PaymentsModule (el webhook avisa al confirmar), AppointmentsModule
 * (la cancelación avisa al profesional) y JobsModule (recordatorios). No importa
 * a ninguno de los tres, así que no hay ciclo.
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    EmailService,
    AppointmentNotificationsService,
    InAppNotificationsService,
  ],
  exports: [AppointmentNotificationsService, InAppNotificationsService],
})
export class NotificationsModule {}
