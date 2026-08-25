import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { AvailabilityController } from './availability.controller';

@Module({
  controllers: [AvailabilityController, AppointmentsController],
  providers: [AppointmentsService],
  // ENG-56 (videoconsulta) y ENG-55 (ver mis turnos) van a necesitar leer turnos;
  // se exporta para que no reimplementen el acceso.
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
