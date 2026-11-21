import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * ENG-205 — los límites de plataforma de la política de cancelación viven en la
 * base: aunque algo se saltee el service, no se puede guardar una política
 * abusiva. `db push` no crea el CHECK, así que el spec lo carga de la migración.
 */
const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261121150000_eng205_policy_limits_refund_retries',
  'migration.sql',
);

describe('Límites de la política de cancelación (integration, ENG-205)', () => {
  const prisma = new PrismaClient();
  const professionalId = randomUUID();

  beforeAll(async () => {
    const check = readFileSync(MIGRATION, 'utf8')
      .split(/^--;;[ \t]*\r?$/m)
      .map((s) => s.replace(/^--.*$/gm, '').trim())
      .find((s) =>
        s.startsWith('ALTER TABLE "cancellation_policies" ADD CONSTRAINT'),
      );
    expect(check).toBeDefined();
    await prisma.$executeRawUnsafe(check!).catch((e: unknown) => {
      if (!/already exists/.test(String(e))) throw e;
    });
    await prisma.profile.create({
      data: {
        id: professionalId,
        email: `pro-${professionalId}@test.local`,
        role: 'PROFESIONAL',
      },
    });
    await prisma.professional.create({
      data: {
        profile_id: professionalId,
        first_name: 'Ana',
        last_name: 'Profesional',
        license_number: `MP-${professionalId.slice(0, 8)}`,
      },
    });
  });

  afterAll(async () => {
    await prisma.cancellationPolicy.deleteMany({
      where: { professional_id: professionalId },
    });
    await prisma.professional.deleteMany({
      where: { profile_id: professionalId },
    });
    await prisma.profile.deleteMany({ where: { id: professionalId } });
    await prisma.$disconnect();
  });

  it('acepta una política dentro de los límites', async () => {
    await expect(
      prisma.cancellationPolicy.upsert({
        where: { professional_id: professionalId },
        create: {
          professional_id: professionalId,
          hours_full_refund: 24,
          hours_partial_refund: 6,
          partial_refund_percent: 30,
        },
        update: {
          hours_full_refund: 24,
          hours_partial_refund: 6,
          partial_refund_percent: 30,
        },
      }),
    ).resolves.toBeDefined();
  });

  it('rechaza un total que exige más de 24 h', async () => {
    await expect(
      prisma.cancellationPolicy.update({
        where: { professional_id: professionalId },
        data: { hours_full_refund: 48 },
      }),
    ).rejects.toThrow();
  });

  it('rechaza un parcial menor al 30 %', async () => {
    await expect(
      prisma.cancellationPolicy.update({
        where: { professional_id: professionalId },
        data: { partial_refund_percent: 10 },
      }),
    ).rejects.toThrow();
  });
});
