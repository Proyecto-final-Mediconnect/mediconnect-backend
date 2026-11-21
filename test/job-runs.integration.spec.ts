import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';
import { JobRunnerService } from '../src/jobs/job-runner.service';
import type { PrismaService } from '../src/prisma/prisma.service';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  captureCheckIn: jest.fn(),
}));

/**
 * ENG-228 — la bitácora de jobs contra Postgres real.
 *
 * Lo que importa probar acá es lo que un mock no puede: que el índice único
 * parcial deja **una sola** corrida en curso por job aunque dos requests lleguen
 * a la vez, y que los CHECK rechazan filas incoherentes.
 *
 * `db push` crea la tabla pero no lo que Prisma no modela (el índice parcial y
 * los CHECK), así que este spec carga esas sentencias de la migración.
 */
const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261121120000_eng228_job_runs',
  'migration.sql',
);

async function applyConstraints(prisma: PrismaClient) {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split(/^--;;[ \t]*\r?$/m)
    .map((s) => s.trim())
    .filter((s) =>
      /^(ALTER TABLE "job_runs" ADD CONSTRAINT|CREATE UNIQUE INDEX "job_runs_one_running_per_job")/m.test(
        s.replace(/^--.*$/gm, '').trim(),
      ),
    );
  expect(statements).toHaveLength(3);
  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (error) {
      // Una corrida anterior del suite contra la misma base ya las creó.
      if (!/already exists/.test(String(error))) throw error;
    }
  }
}

describe('Bitácora de jobs (integration, ENG-228)', () => {
  const prisma = new PrismaClient();
  const runner = new JobRunnerService(prisma as unknown as PrismaService);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await applyConstraints(prisma);
  });

  beforeEach(() => prisma.jobRun.deleteMany());

  afterAll(async () => {
    await prisma.jobRun.deleteMany();
    await prisma.$disconnect();
  });

  it('deja una fila OK con resultado y duración', async () => {
    await runner.run('release-unpaid-appointments', () =>
      Promise.resolve({ released: 3 }),
    );

    const rows = await prisma.jobRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job: 'release-unpaid-appointments',
      status: 'OK',
      result: { released: 3 },
    });
    expect(rows[0].finished_at).not.toBeNull();
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('dos corridas simultáneas del mismo job: corre una y la otra se saltea', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const work = jest.fn(async () => {
      await gate;
      return { closed: 1 };
    });

    const first = runner.run('close-expired-medipass-sessions', work);
    // La segunda llega mientras la primera sigue en curso.
    await new Promise((r) => setTimeout(r, 50));
    const second = await runner.run('close-expired-medipass-sessions', work);
    release();

    expect(second).toEqual({ skipped: true, reason: 'RUNNING' });
    await expect(first).resolves.toEqual({ closed: 1 });
    expect(work).toHaveBeenCalledTimes(1);
    expect(await prisma.jobRun.count()).toBe(1);
  });

  it('jobs distintos sí corren a la vez', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const a = runner.run('send-review-requests', async () => {
      await gate;
      return {};
    });
    await new Promise((r) => setTimeout(r, 50));
    const b = await runner.run('send-appointment-reminders', () =>
      Promise.resolve({}),
    );
    release();
    await a;

    expect(b).toEqual({});
    expect(await prisma.jobRun.count({ where: { status: 'OK' } })).toBe(2);
  });

  it('una corrida colgada se cierra como ERROR y no bloquea la siguiente', async () => {
    await prisma.jobRun.create({
      data: {
        job: 'close-finished-appointments',
        status: 'RUNNING',
        started_at: new Date(Date.now() - 11 * 60_000),
      },
    });

    const result = await runner.run('close-finished-appointments', () =>
      Promise.resolve({ completed: 0, noShow: 0 }),
    );

    expect(result).toEqual({ completed: 0, noShow: 0 });
    const statuses = (
      await prisma.jobRun.findMany({ orderBy: { started_at: 'asc' } })
    ).map((r) => r.status);
    expect(statuses).toEqual(['ERROR', 'OK']);
  });

  it('un error queda registrado con su mensaje', async () => {
    await expect(
      runner.run('send-review-requests', () =>
        Promise.reject(new Error('SMTP caído')),
      ),
    ).rejects.toThrow('SMTP caído');

    const row = await prisma.jobRun.findFirstOrThrow();
    expect(row).toMatchObject({ status: 'ERROR', error: 'SMTP caído' });
  });

  it('la base rechaza un estado inválido o una corrida terminada sin fin', async () => {
    await expect(
      prisma.jobRun.create({ data: { job: 'x', status: 'LISTO' } }),
    ).rejects.toThrow();
    await expect(
      prisma.jobRun.create({ data: { job: 'x', status: 'OK' } }),
    ).rejects.toThrow();
  });

  it('el estado marca al día lo que corrió y atrasado lo que no', async () => {
    await runner.run('release-unpaid-appointments', () => Promise.resolve({}));

    const jobs = await runner.status();

    expect(
      jobs.find((j) => j.job === 'release-unpaid-appointments')?.stale,
    ).toBe(false);
    expect(jobs.find((j) => j.job === 'send-review-requests')?.stale).toBe(
      true,
    );
  });
});
