import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * `legal_acceptances` contra Postgres real (ENG-140).
 *
 * La inmutabilidad es la propiedad central de la tabla —es la prueba del
 * consentimiento— y vive en triggers, así que solo se puede probar contra una
 * base de verdad. Mismo esquema que `clinical-records-hardening`.
 *
 * `scripts/test-integration.sh` arma la base con `prisma db push`: el enum, la
 * tabla, el índice y la FK ya existen. De la migración se aplica lo que el
 * schema de Prisma no expresa (triggers, REVOKE, RLS). Al terminar se sacan los
 * triggers: los specs de integración comparten base.
 */

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261013130000_eng140_legal_acceptances',
  'migration.sql',
);

/** Lo que ya creó `prisma db push` desde schema.prisma. */
const CREATED_BY_DB_PUSH =
  /^(CREATE TYPE|CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE "legal_acceptances" ADD CONSTRAINT)/;

const VERSION = '2026-10-13';

const createdProfiles: string[] = [];

/** Aplica los statements de la migración que no vienen del schema (`--;;`). */
async function applyMigration(prisma: PrismaClient) {
  for (const statement of readFileSync(MIGRATION, 'utf8').split(
    /^--;;[ \t]*\r?$/m,
  )) {
    const sql = statement.trim();
    if (sql.length === 0 || CREATED_BY_DB_PUSH.test(sql)) continue;
    await prisma.$executeRawUnsafe(sql);
  }
}

/** SQLSTATE del error de Postgres, venga por `$executeRaw` o por el client. */
async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; meta?: { code?: string } };
    const message = String((error as Error).message);
    return e.meta?.code ?? message.match(/\b(42501|23503)\b/)?.[1] ?? '?';
  }
  throw new Error('Se esperaba que la operación fallara');
}

describe('legal_acceptances (integration, ENG-140)', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await applyMigration(prisma);
  }, 60_000);

  afterAll(async () => {
    for (const sql of [
      'drop trigger if exists legal_acceptances_no_truncate on public.legal_acceptances',
      'drop trigger if exists legal_acceptances_no_mutation on public.legal_acceptances',
      'alter table public.legal_acceptances disable row level security',
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    await prisma.legalAcceptance.deleteMany({
      where: { profile_id: { in: createdProfiles } },
    });
    await prisma.profile.deleteMany({
      where: { id: { in: createdProfiles } },
    });
    await prisma.$disconnect();
  });

  async function createProfileWithAcceptance(): Promise<string> {
    const id = randomUUID();
    await prisma.profile.create({
      data: { id, email: `legal-${id}@test.local`, role: 'PACIENTE' },
    });
    createdProfiles.push(id);
    await prisma.legalAcceptance.createMany({
      data: [
        {
          profile_id: id,
          version: VERSION,
          source: 'REGISTER',
          ip: '203.0.113.7',
          user_agent: 'MediConnectTest/1.0',
        },
      ],
      skipDuplicates: true,
    });
    return id;
  }

  it('guarda quién, qué versión, cuándo, por dónde, IP y user-agent', async () => {
    const id = await createProfileWithAcceptance();

    const row = await prisma.legalAcceptance.findUniqueOrThrow({
      where: { profile_id_version: { profile_id: id, version: VERSION } },
    });

    expect(row).toMatchObject({
      source: 'REGISTER',
      ip: '203.0.113.7',
      user_agent: 'MediConnectTest/1.0',
    });
    expect(row.accepted_at).toBeInstanceOf(Date);
  });

  it('ip y user_agent son opcionales', async () => {
    const id = randomUUID();
    await prisma.profile.create({
      data: { id, email: `legal-${id}@test.local`, role: 'PACIENTE' },
    });
    createdProfiles.push(id);

    await expect(
      prisma.legalAcceptance.create({
        data: { profile_id: id, version: VERSION, source: 'REACCEPT' },
      }),
    ).resolves.toMatchObject({ ip: null, user_agent: null });
  });

  it('aceptar dos veces la misma versión no falla ni duplica (skipDuplicates)', async () => {
    const id = await createProfileWithAcceptance();

    await expect(
      prisma.legalAcceptance.createMany({
        data: [{ profile_id: id, version: VERSION, source: 'REACCEPT' }],
        skipDuplicates: true,
      }),
    ).resolves.toEqual({ count: 0 });
    await expect(
      prisma.legalAcceptance.count({ where: { profile_id: id } }),
    ).resolves.toBe(1);
  });

  it('UPDATE falla con 42501', async () => {
    const id = await createProfileWithAcceptance();

    await expect(
      sqlState(
        prisma.$executeRawUnsafe(
          `update public.legal_acceptances set version = '1999-01-01' where profile_id = '${id}'`,
        ),
      ),
    ).resolves.toBe('42501');
  });

  it('DELETE falla con 42501', async () => {
    const id = await createProfileWithAcceptance();

    await expect(
      sqlState(
        prisma.$executeRawUnsafe(
          `delete from public.legal_acceptances where profile_id = '${id}'`,
        ),
      ),
    ).resolves.toBe('42501');
    await expect(
      prisma.legalAcceptance.count({ where: { profile_id: id } }),
    ).resolves.toBe(1);
  });

  it('TRUNCATE falla con 42501, incluso para el owner', async () => {
    await createProfileWithAcceptance();
    const before = await prisma.legalAcceptance.count();

    await expect(
      sqlState(
        prisma.$executeRawUnsafe('truncate table public.legal_acceptances'),
      ),
    ).resolves.toBe('42501');
    await expect(prisma.legalAcceptance.count()).resolves.toBe(before);
  });

  it('borrar un perfil que aceptó falla (FK RESTRICT): la prueba no se pierde', async () => {
    const id = await createProfileWithAcceptance();

    await expect(
      sqlState(
        prisma.$executeRawUnsafe(
          `delete from public.profiles where id = '${id}'`,
        ),
      ),
    ).resolves.toBe('23503');
    await expect(prisma.profile.count({ where: { id } })).resolves.toBe(1);
  });
});
