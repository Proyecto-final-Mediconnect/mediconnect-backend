import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { AvailabilityController } from './availability.controller';

@Module({
  // Para vencer el link de pago al cancelar. PaymentsModule no importa este
  // módulo, así que no hay ciclo.
  imports: [PaymentsModule],
  controllers: [AvailabilityController, AppointmentsController],
  providers: [AppointmentsService],
  // ENG-56 (videoconsulta) y ENG-55 (ver mis turnos) van a necesitar leer turnos;
  // se exporta para que no reimplementen el acceso.
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
