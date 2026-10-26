import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProfessionalsModule } from '../professionals/professionals.module';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { AvailabilityController } from './availability.controller';
import { UnpaidReleaseService } from './unpaid-release.service';

@Module({
  // PaymentsModule, para vencer el link de pago al cancelar; NotificationsModule,
  // para avisarle al profesional (ENG-69). Ninguno importa este módulo, así que
  // no hay ciclo.
  imports: [PaymentsModule, NotificationsModule, ProfessionalsModule],
  controllers: [AvailabilityController, AppointmentsController],
  providers: [AppointmentsService, UnpaidReleaseService],
  // ENG-56 (videoconsulta) y ENG-55 (ver mis turnos) van a necesitar leer turnos;
  // se exporta para que no reimplementen el acceso.
  // UnpaidReleaseService, para el job de ENG-101 (JobsModule).
  exports: [AppointmentsService, UnpaidReleaseService],
})
export class AppointmentsModule {}
