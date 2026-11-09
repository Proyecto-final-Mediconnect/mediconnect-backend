import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AppointmentClosingService } from '../appointments/appointment-closing.service';
import { UnpaidReleaseService } from '../appointments/unpaid-release.service';
import { MediPassService } from '../medipass/medipass.service';
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
    private readonly medipass: MediPassService,
    private readonly closing: AppointmentClosingService,
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

  /**
   * Deja escrito el cierre de los accesos al MediPass que vencieron o se
   * cortaron (ENG-104). Idempotente: correrlo dos veces no cambia nada.
   */
  @Post('close-expired-medipass-sessions')
  @HttpCode(HttpStatus.OK)
  async closeExpiredMediPassSessions(): Promise<{ closed: number }> {
    return { closed: await this.medipass.closeExpiredSessions() };
  }

  /**
   * ENG-190: un mail por turno pidiendo la reseña, 3 horas después de que
   * cierra la sala. Idempotente: el envío se reclama en `notifications`.
   */
  @Post('send-review-requests')
  @HttpCode(HttpStatus.OK)
  sendReviewRequests(): Promise<SendSummary> {
    return this.notifications.sendReviewRequests();
  }

  /**
   * ENG-189: cierra los turnos confirmados cuya sala ya cerró, según quién
   * entró. No toca los turnos a los que el profesional no entró.
   */
  @Post('close-finished-appointments')
  @HttpCode(HttpStatus.OK)
  async closeFinishedAppointments(): Promise<{
    completed: number;
    noShow: number;
  }> {
    const closed = await this.closing.closeFinished();
    return {
      completed: closed.filter((c) => c.status === 'COMPLETADO').length,
      noShow: closed.filter((c) => c.status === 'NO_ASISTIO').length,
    };
  }
}
