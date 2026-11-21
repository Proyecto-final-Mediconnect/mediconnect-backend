import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  JOB_MAX_RUNTIME_MINUTES,
  JOB_NAMES,
  JOBS,
  type JobName,
  SCHEDULER_MONITOR,
  staleAfterMinutes,
} from './jobs.config';

/** Lo que devuelve un job que se salteó porque otra corrida seguía en curso. */
export interface SkippedRun {
  skipped: true;
  reason: 'RUNNING';
}

export interface JobStatus {
  job: JobName;
  everyMinutes: number;
  lastStatus: 'RUNNING' | 'OK' | 'ERROR' | null;
  lastStartedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  /** Sin una corrida OK dentro de `staleAfterMinutes`. */
  stale: boolean;
}

/** Tope del mensaje de error guardado: alcanza para diagnosticar y no crece sin control. */
const MAX_ERROR_LENGTH = 1000;

/**
 * Corre un job dejando registro en `job_runs` (ENG-228).
 *
 * - **Una corrida por vez:** el índice único parcial sobre `RUNNING` hace que
 *   una segunda corrida simultánea choque al insertar y se saltee.
 * - **Corridas colgadas:** una fila `RUNNING` más vieja que
 *   `JOB_MAX_RUNTIME_MINUTES` es de un proceso que murió; se cierra como `ERROR`
 *   antes de empezar la nueva, así el job no queda bloqueado.
 * - **Errores:** quedan en la fila y van a Sentry con el nombre del job. El
 *   error se vuelve a lanzar para que el scheduler reciba un 500.
 * - **Silencio:** el job de `SCHEDULER_MONITOR` manda check-ins a Sentry Crons,
 *   que alerta si dejan de llegar.
 */
@Injectable()
export class JobRunnerService {
  private readonly logger = new Logger(JobRunnerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async run<T extends object>(
    job: JobName,
    work: () => Promise<T>,
    now: () => Date = () => new Date(),
  ): Promise<T | SkippedRun> {
    const startedAt = now();
    await this.closeHungRuns(job, startedAt);

    let runId: string;
    try {
      ({ id: runId } = await this.prisma.jobRun.create({
        data: { job, status: 'RUNNING', started_at: startedAt },
        select: { id: true },
      }));
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.log(`${job}: otra corrida sigue en curso, se saltea.`);
        return { skipped: true, reason: 'RUNNING' };
      }
      throw error;
    }

    const checkInId = this.checkIn(job, 'in_progress');
    try {
      const result = await work();
      const finishedAt = now();
      await this.prisma.jobRun.update({
        where: { id: runId },
        data: {
          status: 'OK',
          finished_at: finishedAt,
          duration_ms: finishedAt.getTime() - startedAt.getTime(),
          result: result as Prisma.InputJsonObject,
        },
      });
      this.checkIn(job, 'ok', checkInId);
      return result;
    } catch (error) {
      const finishedAt = now();
      const message = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, MAX_ERROR_LENGTH);
      await this.prisma.jobRun
        .update({
          where: { id: runId },
          data: {
            status: 'ERROR',
            finished_at: finishedAt,
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            error: message,
          },
        })
        // Si tampoco se puede escribir el error (la base cayó), que no tape el
        // error original: el aviso a Sentry de abajo igual sale.
        .catch((writeError: unknown) =>
          this.logger.error(
            `${job}: no se pudo registrar el error: ${String(writeError)}`,
          ),
        );
      this.checkIn(job, 'error', checkInId);
      this.logger.error(`${job} falló: ${message}`);
      Sentry.captureException(error, {
        tags: { feature: 'eng228', job },
      });
      throw error;
    }
  }

  /** Estado de cada job para `/internal/jobs/status`. */
  async status(now: Date = new Date()): Promise<JobStatus[]> {
    return Promise.all(
      JOB_NAMES.map(async (job) => {
        const [last, lastOk] = await Promise.all([
          this.prisma.jobRun.findFirst({
            where: { job },
            orderBy: { started_at: 'desc' },
            select: { status: true, started_at: true, error: true },
          }),
          this.prisma.jobRun.findFirst({
            where: { job, status: 'OK' },
            orderBy: { started_at: 'desc' },
            select: { started_at: true },
          }),
        ]);
        const limit = now.getTime() - staleAfterMinutes(job) * 60_000;
        return {
          job,
          everyMinutes: JOBS[job].everyMinutes,
          lastStatus: (last?.status ?? null) as JobStatus['lastStatus'],
          lastStartedAt: last?.started_at.toISOString() ?? null,
          lastOkAt: lastOk?.started_at.toISOString() ?? null,
          lastError: last?.status === 'ERROR' ? last.error : null,
          stale: !lastOk || lastOk.started_at.getTime() < limit,
        };
      }),
    );
  }

  private async closeHungRuns(job: JobName, now: Date): Promise<void> {
    const closed = await this.prisma.jobRun.updateMany({
      where: {
        job,
        status: 'RUNNING',
        started_at: {
          lt: new Date(now.getTime() - JOB_MAX_RUNTIME_MINUTES * 60_000),
        },
      },
      data: {
        status: 'ERROR',
        finished_at: now,
        error: `Quedó sin terminar más de ${JOB_MAX_RUNTIME_MINUTES} minutos (el proceso se reinició o se colgó).`,
      },
    });
    if (closed.count > 0) {
      this.logger.warn(
        `${job}: se cerraron ${closed.count} corridas colgadas.`,
      );
      Sentry.captureMessage(`Job ${job}: corrida colgada cerrada`, {
        level: 'warning',
        tags: { feature: 'eng228', job },
      });
    }
  }

  /** Check-in de Sentry Crons, solo para el job que vigila al scheduler. */
  private checkIn(
    job: JobName,
    status: 'in_progress' | 'ok' | 'error',
    checkInId?: string,
  ): string | undefined {
    if (job !== SCHEDULER_MONITOR.job) return undefined;
    if (status === 'in_progress') {
      return Sentry.captureCheckIn(
        { monitorSlug: SCHEDULER_MONITOR.slug, status },
        SCHEDULER_MONITOR.config,
      );
    }
    // Sin el id del check-in abierto, Sentry lo registra como uno suelto.
    return Sentry.captureCheckIn(
      checkInId
        ? { monitorSlug: SCHEDULER_MONITOR.slug, status, checkInId }
        : { monitorSlug: SCHEDULER_MONITOR.slug, status },
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
