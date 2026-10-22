import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * ENG-65 — el trigger que congela la política de cancelación en el turno.
 *
 * `db push` no corre el SQL de las migraciones (ver
 * `medipass-code-unique.integration.spec.ts`), así que el trigger solo existe si
 * este spec carga la migración. Se verifica contra Postgres porque es lo único
 * que impide que un paciente reserve por PostgREST con la política que quiera.
 */

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261022120000_eng65_refunds',
  'migration.sql',
);

/** Carga un archivo de migración statement por statement (separador `--;;`). */
async function applyMigration(prisma: PrismaClient, path: string) {
  for (const statement of readFileSync(path, 'utf8').split(
    /^--;;[ \t]*\r?$/m,
  )) {
    const sql = statement.trim();
    if (sql.length > 0) await prisma.$executeRawUnsafe(sql);
  }
}

describe('Política de cancelación congelada en el turno (integration)', () => {
  const prisma = new PrismaClient();

  const patientId = randomUUID();
  const withPolicy = randomUUID();
  const withoutPolicy = randomUUID();
  let slot = 0;

  /** Inserta un turno como lo haría el cliente, mandando una política propia. */
  async function book(professionalId: string): Promise<string> {
    const id = randomUUID();
    slot += 1;
    await prisma.$executeRawUnsafe(
      `insert into public.appointments
         (id, patient_id, professional_id, scheduled_at, duration_minutes, price,
          policy_hours_full_refund, policy_hours_partial_refund, policy_partial_refund_percent)
       values ($1::uuid, $2::uuid, $3::uuid, now() + ($4 || ' days')::interval, 30, 15000, 0, 0, 100)`,
      id,
      patientId,
      professionalId,
      String(slot),
    );
    return id;
  }

  beforeAll(async () => {
    await applyMigration(prisma, MIGRATION);

    await prisma.profile.createMany({
      data: [
        { id: patientId, email: `p-${patientId}@test.local`, role: 'PACIENTE' },
        ...[withPolicy, withoutPolicy].map((id) => ({
          id,
          email: `pro-${id}@test.local`,
          role: 'PROFESIONAL' as const,
        })),
      ],
    });
    await prisma.patient.create({
      data: {
        profile_id: patientId,
        first_name: 'Test',
        last_name: 'Paciente',
      },
    });
    await prisma.professional.createMany({
      data: [withPolicy, withoutPolicy].map((id) => ({
        profile_id: id,
        first_name: 'Test',
        last_name: 'Profesional',
        license_number: `MP-${id.slice(0, 8)}`,
      })),
    });
    await prisma.cancellationPolicy.create({
      data: {
        professional_id: withPolicy,
        hours_full_refund: 72,
        hours_partial_refund: 48,
        partial_refund_percent: 20,
      },
    });
  });

  afterAll(async () => {
    const pros = [withPolicy, withoutPolicy];
    await prisma.appointment.deleteMany({ where: { patient_id: patientId } });
    await prisma.cancellationPolicy.deleteMany({
      where: { professional_id: { in: pros } },
    });
    await prisma.professional.deleteMany({
      where: { profile_id: { in: pros } },
    });
    await prisma.patient.deleteMany({ where: { profile_id: patientId } });
    await prisma.profile.deleteMany({
      where: { id: { in: [patientId, ...pros] } },
    });
    await prisma.$disconnect();
  });

  it('copia la política del profesional e ignora la que manda el cliente', async () => {
    const id = await book(withPolicy);

    await expect(
      prisma.appointment.findUnique({
        where: { id },
        select: {
          policy_hours_full_refund: true,
          policy_hours_partial_refund: true,
          policy_partial_refund_percent: true,
        },
      }),
    ).resolves.toEqual({
      policy_hours_full_refund: 72,
      policy_hours_partial_refund: 48,
      policy_partial_refund_percent: 20,
    });
  });

  it('sin política configurada deja NULL, que es el default', async () => {
    const id = await book(withoutPolicy);

    await expect(
      prisma.appointment.findUnique({
        where: { id },
        select: {
          policy_hours_full_refund: true,
          policy_hours_partial_refund: true,
          policy_partial_refund_percent: true,
        },
      }),
    ).resolves.toEqual({
      policy_hours_full_refund: null,
      policy_hours_partial_refund: null,
      policy_partial_refund_percent: null,
    });
  });

  it('cambiar la política después no toca los turnos ya reservados', async () => {
    const id = await book(withPolicy);

    await prisma.cancellationPolicy.update({
      where: { professional_id: withPolicy },
      data: { partial_refund_percent: 0 },
    });

    await expect(
      prisma.appointment.findUnique({
        where: { id },
        select: { policy_partial_refund_percent: true },
      }),
    ).resolves.toEqual({ policy_partial_refund_percent: 20 });
  });
});
