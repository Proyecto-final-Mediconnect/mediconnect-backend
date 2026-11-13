import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProfessionalsModule } from '../professionals/professionals.module';
import { VideoModule } from '../video/video.module';
import { AppointmentClosingService } from './appointment-closing.service';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { AvailabilityController } from './availability.controller';
import { UnpaidReleaseService } from './unpaid-release.service';

@Module({
  // PaymentsModule, para vencer el link de pago al cancelar; NotificationsModule,
  // para avisarle al profesional (ENG-69). Ninguno importa este módulo, así que
  // no hay ciclo. VideoModule, por DailyService: al finalizar a mano se borra la
  // sala (VideoModule no importa este módulo).
  imports: [
    PaymentsModule,
    NotificationsModule,
    ProfessionalsModule,
    VideoModule,
  ],
  controllers: [AvailabilityController, AppointmentsController],
  providers: [
    AppointmentsService,
    UnpaidReleaseService,
    AppointmentClosingService,
  ],
  // ENG-56 (videoconsulta) y ENG-55 (ver mis turnos) van a necesitar leer turnos;
  // se exporta para que no reimplementen el acceso.
  // UnpaidReleaseService y AppointmentClosingService, para los jobs de ENG-101
  // y ENG-189 (JobsModule).
  exports: [
    AppointmentsService,
    UnpaidReleaseService,
    AppointmentClosingService,
  ],
})
export class AppointmentsModule {}
