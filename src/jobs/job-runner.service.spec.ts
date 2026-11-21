import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { JobRunnerService } from './job-runner.service';
import { JOB_MAX_RUNTIME_MINUTES, SCHEDULER_MONITOR } from './jobs.config';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  captureCheckIn: jest.fn(() => 'check-in-1'),
}));

const T0 = new Date('2026-11-21T12:00:00.000Z');
const T1 = new Date('2026-11-21T12:00:01.500Z');

function prismaMock() {
  return {
    jobRun: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: 'run-1' }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn(),
    },
  };
}

function clock(...dates: Date[]) {
  let i = 0;
  return () => dates[Math.min(i++, dates.length - 1)];
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('JobRunnerService', () => {
  let prisma: ReturnType<typeof prismaMock>;
  let runner: JobRunnerService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma = prismaMock();
    runner = new JobRunnerService(prisma as unknown as PrismaService);
  });

  describe('run', () => {
    it('registra la corrida OK con su resultado y su duración', async () => {
      const result = await runner.run(
        'release-unpaid-appointments',
        () => Promise.resolve({ released: 2 }),
        clock(T0, T1),
      );

      expect(result).toEqual({ released: 2 });
      expect(prisma.jobRun.create).toHaveBeenCalledWith({
        data: {
          job: 'release-unpaid-appointments',
          status: 'RUNNING',
          started_at: T0,
        },
        select: { id: true },
      });
      expect(prisma.jobRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: {
          status: 'OK',
          finished_at: T1,
          duration_ms: 1500,
          result: { released: 2 },
        },
      });
    });

    it('registra el error, avisa a Sentry y lo vuelve a lanzar', async () => {
      const boom = new Error('SMTP caído');

      await expect(
        runner.run(
          'send-review-requests',
          () => Promise.reject(boom),
          clock(T0, T1),
        ),
      ).rejects.toBe(boom);

      expect(prisma.jobRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: {
          status: 'ERROR',
          finished_at: T1,
          duration_ms: 1500,
          error: 'SMTP caído',
        },
      });
      expect(Sentry.captureException).toHaveBeenCalledWith(boom, {
        tags: { feature: 'eng228', job: 'send-review-requests' },
      });
    });

    it('recorta un mensaje de error largo', async () => {
      await expect(
        runner.run(
          'send-review-requests',
          () => Promise.reject(new Error('x'.repeat(5000))),
          clock(T0, T1),
        ),
      ).rejects.toThrow();

      const { error } = prisma.jobRun.update.mock.calls[0][0].data;
      expect(error).toHaveLength(1000);
    });

    it('si no puede registrar el error, igual avisa a Sentry y lanza el original', async () => {
      const boom = new Error('job roto');
      prisma.jobRun.update.mockRejectedValue(new Error('base caída'));

      await expect(
        runner.run(
          'send-review-requests',
          () => Promise.reject(boom),
          clock(T0, T1),
        ),
      ).rejects.toBe(boom);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        boom,
        expect.anything(),
      );
    });

    it('saltea la corrida si otra del mismo job sigue en curso', async () => {
      prisma.jobRun.create.mockRejectedValue(uniqueViolation());
      const work = jest.fn();

      const result = await runner.run(
        'close-finished-appointments',
        work,
        clock(T0),
      );

      expect(result).toEqual({ skipped: true, reason: 'RUNNING' });
      expect(work).not.toHaveBeenCalled();
      expect(prisma.jobRun.update).not.toHaveBeenCalled();
    });

    it('propaga un error de base que no es la corrida duplicada', async () => {
      prisma.jobRun.create.mockRejectedValue(new Error('timeout'));

      await expect(
        runner.run('close-finished-appointments', jest.fn(), clock(T0)),
      ).rejects.toThrow('timeout');
    });

    it('cierra como ERROR las corridas colgadas antes de empezar', async () => {
      prisma.jobRun.updateMany.mockResolvedValue({ count: 1 });

      await runner.run(
        'release-unpaid-appointments',
        () => Promise.resolve({ released: 0 }),
        clock(T0, T1),
      );

      expect(prisma.jobRun.updateMany).toHaveBeenCalledWith({
        where: {
          job: 'release-unpaid-appointments',
          status: 'RUNNING',
          started_at: {
            lt: new Date(T0.getTime() - JOB_MAX_RUNTIME_MINUTES * 60_000),
          },
        },
        data: expect.objectContaining({ status: 'ERROR', finished_at: T0 }),
      });
      expect(Sentry.captureMessage).toHaveBeenCalled();
      expect(prisma.jobRun.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.jobRun.create.mock.invocationCallOrder[0],
      );
    });

    it('manda check-ins a Sentry Crons solo desde el job que vigila al scheduler', async () => {
      await runner.run(
        SCHEDULER_MONITOR.job,
        () => Promise.resolve({}),
        clock(T0, T1),
      );

      expect(Sentry.captureCheckIn).toHaveBeenNthCalledWith(
        1,
        { monitorSlug: SCHEDULER_MONITOR.slug, status: 'in_progress' },
        SCHEDULER_MONITOR.config,
      );
      expect(Sentry.captureCheckIn).toHaveBeenNthCalledWith(2, {
        monitorSlug: SCHEDULER_MONITOR.slug,
        status: 'ok',
        checkInId: 'check-in-1',
      });

      jest.clearAllMocks();
      await runner.run(
        'release-unpaid-appointments',
        () => Promise.resolve({}),
        clock(T0, T1),
      );
      expect(Sentry.captureCheckIn).not.toHaveBeenCalled();
    });

    it('marca el check-in como error si el job vigilado falla', async () => {
      await expect(
        runner.run(
          SCHEDULER_MONITOR.job,
          () => Promise.reject(new Error('x')),
          clock(T0, T1),
        ),
      ).rejects.toThrow();

      expect(Sentry.captureCheckIn).toHaveBeenLastCalledWith({
        monitorSlug: SCHEDULER_MONITOR.slug,
        status: 'error',
        checkInId: 'check-in-1',
      });
    });
  });

  describe('status', () => {
    const NOW = new Date('2026-11-21T12:00:00.000Z');
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

    it('marca al día un job con un OK reciente y atrasado uno sin OK', async () => {
      prisma.jobRun.findFirst.mockImplementation(
        ({ where }: { where: { job: string; status?: string } }) => {
          if (where.job === 'release-unpaid-appointments') {
            return Promise.resolve(
              where.status
                ? { started_at: minutesAgo(1) }
                : { status: 'OK', started_at: minutesAgo(1), error: null },
            );
          }
          return Promise.resolve(null);
        },
      );

      const jobs = await runner.status(NOW);

      expect(
        jobs.find((j) => j.job === 'release-unpaid-appointments'),
      ).toMatchObject({
        stale: false,
        everyMinutes: 1,
        lastStatus: 'OK',
        lastOkAt: minutesAgo(1).toISOString(),
      });
      expect(jobs.find((j) => j.job === 'send-review-requests')).toMatchObject({
        stale: true,
        lastStatus: null,
        lastOkAt: null,
      });
    });

    it('marca atrasado un job cuyo último OK es más viejo que el límite y muestra el último error', async () => {
      prisma.jobRun.findFirst.mockImplementation(
        ({ where }: { where: { status?: string } }) =>
          Promise.resolve(
            where.status
              ? { started_at: minutesAgo(16) }
              : {
                  status: 'ERROR',
                  started_at: minutesAgo(1),
                  error: 'SMTP caído',
                },
          ),
      );

      const jobs = await runner.status(NOW);

      expect(
        jobs.find((j) => j.job === 'send-appointment-reminders'),
      ).toMatchObject({
        stale: true,
        lastStatus: 'ERROR',
        lastError: 'SMTP caído',
      });
    });
  });
});
