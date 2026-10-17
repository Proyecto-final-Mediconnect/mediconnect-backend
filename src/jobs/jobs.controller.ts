import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UnpaidReleaseService } from '../appointments/unpaid-release.service';
import {
  AppointmentNotificationsService,
  type SendSummary,
} from '../notifications/appointment-notifications.service';
import { JobSecretGuard } from './job-secret.guard';

/**
 * Tareas periódicas que dispara `.github/workflows/scheduled-jobs.yml`.
 *
 * Viven como endpoints y no como un cron dentro de Nest porque el plan gratis
 * de Render duerme el proceso: el request del workflow lo despierta. Cada
 * endpoint tiene que ser **idempotente**, porque GitHub puede demorar una
 * corrida y juntarla con la siguiente, y un reintento de `curl` repite el
 * request.
 */
@Controller('internal/jobs')
@UseGuards(JobSecretGuard)
export class JobsController {
  constructor(
    private readonly unpaidRelease: UnpaidReleaseService,
    private readonly notifications: AppointmentNotificationsService,
  ) {}

  /** ENG-101: libera los turnos que no se pagaron en 15 minutos. */
  @Post('release-unpaid-appointments')
  @HttpCode(HttpStatus.OK)
  async releaseUnpaidAppointments(): Promise<{ released: number }> {
    const ids = await this.unpaidRelease.releaseExpired();
    return { released: ids.length };
  }

  /** ENG-68: confirmaciones pendientes y recordatorios a 24 h y a 1 h. */
  @Post('send-appointment-reminders')
  @HttpCode(HttpStatus.OK)
  sendAppointmentReminders(): Promise<SendSummary> {
    return this.notifications.sendDue();
  }
}
