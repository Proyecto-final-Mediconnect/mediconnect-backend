import { Module } from '@nestjs/common';
import { AppointmentNotificationsService } from './appointment-notifications.service';
import { EmailService } from './email.service';
import { InAppNotificationsService } from './in-app-notifications.service';
import { NotificationsController } from './notifications.controller';
import { PushTokensController } from './push-tokens.controller';
import { PatientNoticesService } from './patient-notices.service';
import { ProfessionalAccountNoticesService } from './professional-account-notices.service';
import { PushService } from './push.service';

/**
 * EP-08 — Comunicación.
 *
 * Los emails de turno (ENG-68), la bandeja de avisos in-app (ENG-69) y el push a
 * la app mobile (ENG-71). Lo
 * importan PaymentsModule (el webhook avisa al confirmar), AppointmentsModule
 * (la cancelación avisa al profesional) y JobsModule (recordatorios). No importa
 * a ninguno de los tres, así que no hay ciclo.
 */
@Module({
  controllers: [NotificationsController, PushTokensController],
  providers: [
    EmailService,
    AppointmentNotificationsService,
    InAppNotificationsService,
    PatientNoticesService,
    ProfessionalAccountNoticesService,
    PushService,
  ],
  exports: [
    AppointmentNotificationsService,
    InAppNotificationsService,
    PatientNoticesService,
    ProfessionalAccountNoticesService,
    PushService,
  ],
})
export class NotificationsModule {}
