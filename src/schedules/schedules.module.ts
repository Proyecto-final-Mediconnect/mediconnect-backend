import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

@Module({
  // ENG-206: un bloqueo que pisa turnos los cancela como el profesional.
  imports: [AppointmentsModule],
  controllers: [SchedulesController],
  providers: [SchedulesService],
})
export class SchedulesModule {}
