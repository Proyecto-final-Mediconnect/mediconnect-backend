import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  ServiceUnavailableException,
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
import {
  type JobStatus,
  JobRunnerService,
  type SkippedRun,
} from './job-runner.service';

/**
 * Tareas periódicas. Las dispara `pg_cron` desde Supabase
 * (`scripts/scheduler/pg-cron.sql`, ENG-228), con
 * `.github/workflows/scheduled-jobs.yml` como respaldo.
 *
 * Viven como endpoints y no como un cron dentro de Nest porque el plan gratis
 * de Render duerme el proceso: el request del scheduler lo despierta (y, al
 * llegar cada minuto, no lo deja dormirse). Cada endpoint tiene que ser
 * **idempotente**: el respaldo de GitHub puede coincidir con `pg_cron`, y un
 * reintento repite el request. Cada corrida queda en `job_runs` y dos corridas
 * del mismo job no se pisan (`JobRunnerService`).
 */
@Controller('internal/jobs')
@UseGuards(JobSecretGuard)
export class JobsController {
  constructor(
    private readonly unpaidRelease: UnpaidReleaseService,
    private readonly notifications: AppointmentNotificationsService,
    private readonly medipass: MediPassService,
    private readonly closing: AppointmentClosingService,
    private readonly runner: JobRunnerService,
  ) {}

  /**
   * Estado de cada job (ENG-228): última corrida, último OK y si está atrasado.
   * Devuelve 503 si alguno está atrasado, para que un `curl -f` lo detecte.
   */
  @Get('status')
  async status(): Promise<{ healthy: true; jobs: JobStatus[] }> {
    const jobs = await this.runner.status();
    if (jobs.some((j) => j.stale)) {
      throw new ServiceUnavailableException({ healthy: false, jobs });
    }
    return { healthy: true, jobs };
  }

  /** ENG-101: libera los turnos que no se pagaron en 15 minutos. */
  @Post('release-unpaid-appointments')
  @HttpCode(HttpStatus.OK)
  releaseUnpaidAppointments(): Promise<{ released: number } | SkippedRun> {
    return this.runner.run('release-unpaid-appointments', async () => {
      const ids = await this.unpaidRelease.releaseExpired();
      return { released: ids.length };
    });
  }

  /** ENG-68: confirmaciones pendientes y recordatorios a 24 h y a 1 h. */
  @Post('send-appointment-reminders')
  @HttpCode(HttpStatus.OK)
  sendAppointmentReminders(): Promise<SendSummary | SkippedRun> {
    return this.runner.run('send-appointment-reminders', () =>
      this.notifications.sendDue(),
    );
  }

  /**
   * Deja escrito el cierre de los accesos al MediPass que vencieron o se
   * cortaron (ENG-104). Idempotente: correrlo dos veces no cambia nada.
   */
  @Post('close-expired-medipass-sessions')
  @HttpCode(HttpStatus.OK)
  closeExpiredMediPassSessions(): Promise<{ closed: number } | SkippedRun> {
    return this.runner.run('close-expired-medipass-sessions', async () => ({
      closed: await this.medipass.closeExpiredSessions(),
    }));
  }

  /**
   * ENG-190: un mail por turno pidiendo la reseña, 3 horas después de que
   * cierra la sala. Idempotente: el envío se reclama en `notifications`.
   */
  @Post('send-review-requests')
  @HttpCode(HttpStatus.OK)
  sendReviewRequests(): Promise<SendSummary | SkippedRun> {
    return this.runner.run('send-review-requests', () =>
      this.notifications.sendReviewRequests(),
    );
  }

  /**
   * ENG-189: cierra los turnos confirmados cuya sala ya cerró, según quién
   * entró. No toca los turnos a los que el profesional no entró.
   */
  @Post('close-finished-appointments')
  @HttpCode(HttpStatus.OK)
  closeFinishedAppointments(): Promise<
    { completed: number; noShow: number } | SkippedRun
  > {
    return this.runner.run('close-finished-appointments', async () => {
      const closed = await this.closing.closeFinished();
      return {
        completed: closed.filter((c) => c.status === 'COMPLETADO').length,
        noShow: closed.filter((c) => c.status === 'NO_ASISTIO').length,
      };
    });
  }
}
