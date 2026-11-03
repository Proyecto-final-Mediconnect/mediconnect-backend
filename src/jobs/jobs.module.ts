import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { MediPassModule } from '../medipass/medipass.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { JobSecretGuard } from './job-secret.guard';
import { JobsController } from './jobs.controller';

/** Endpoints que dispara el scheduler externo (ver `JobsController`). */
@Module({
  imports: [AppointmentsModule, NotificationsModule, MediPassModule],
  controllers: [JobsController],
  providers: [JobSecretGuard],
})
export class JobsModule {}
