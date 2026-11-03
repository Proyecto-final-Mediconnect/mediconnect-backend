import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * `patient_documents` contra Postgres real (ENG-164).
 *
 * Lo que aporta el paciente no se edita ni se borra; solo se puede retirar, una
 * vez. Eso vive en un trigger, así que se prueba contra una base de verdad, con
 * el mismo esquema que `legal-acceptances`: `prisma db push` ya creó el enum, la
 * tabla, los índices y la FK, y de la migración se aplica el resto (trigger,
 * REVOKE, RLS; el bucket se saltea porque no hay schema `storage`).
 */

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261102120000_eng164_patient_documents',
  'migration.sql',
);

const CREATED_BY_DB_PUSH =
  /^(CREATE TYPE|CREATE TABLE|CREATE UNIQUE INDEX|CREATE INDEX|ALTER TABLE "patient_documents" ADD CONSTRAINT)/;

const createdPatients: string[] = [];

async function applyMigration(prisma: PrismaClient) {
  for (const statement of readFileSync(MIGRATION, 'utf8').split(
    /^--;;[ \t]*\r?$/m,
  )) {
    // Los comentarios de cabecera de cada bloque no cuentan para el regex.
    const sql = statement
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim();
    if (sql.length === 0 || CREATED_BY_DB_PUSH.test(sql)) continue;
    await prisma.$executeRawUnsafe(sql);
  }
}

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

describe('patient_documents (integration, ENG-164)', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await applyMigration(prisma);
  }, 60_000);

  afterAll(async () => {
    for (const sql of [
      'drop trigger if exists patient_documents_no_truncate on public.patient_documents',
      'drop trigger if exists patient_documents_no_mutation on public.patient_documents',
      'alter table public.patient_documents disable row level security',
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    await prisma.patientDocument.deleteMany({
      where: { patient_id: { in: createdPatients } },
    });
    await prisma.patient.deleteMany({
      where: { profile_id: { in: createdPatients } },
    });
    await prisma.profile.deleteMany({ where: { id: { in: createdPatients } } });
    await prisma.$disconnect();
  });

  async function createDocument(): Promise<string> {
    const patientId = randomUUID();
    await prisma.profile.create({
      data: {
        id: patientId,
        email: `docs-${patientId}@test.local`,
        role: 'PACIENTE',
      },
    });
    await prisma.patient.create({
      data: { profile_id: patientId, first_name: 'Test', last_name: 'Docs' },
    });
    createdPatients.push(patientId);
    const doc = await prisma.patientDocument.create({
      data: {
        patient_id: patientId,
        type: 'ESTUDIO',
        title: 'Hemograma',
        storage_path: `${patientId}/${randomUUID()}.pdf`,
        sha256: 'a'.repeat(64),
        mime_type: 'application/pdf',
        size_bytes: 1024,
      },
    });
    return doc.id;
  }

  it('retirar un documento lo marca y no toca nada más', async () => {
    const id = await createDocument();

    await prisma.patientDocument.update({
      where: { id },
      data: { withdrawn_at: new Date() },
    });

    const row = await prisma.patientDocument.findUniqueOrThrow({
      where: { id },
    });
    expect(row.withdrawn_at).toBeInstanceOf(Date);
    expect(row.title).toBe('Hemograma');
  });

  it('retirarlo dos veces falla con 42501', async () => {
    const id = await createDocument();
    await prisma.patientDocument.update({
      where: { id },
      data: { withdrawn_at: new Date() },
    });

    await expect(
      sqlState(
        prisma.$executeRawUnsafe(
          `update public.patient_documents set withdrawn_at = now() where id = '${id}'`,
        ),
      ),
    ).resolves.toBe('42501');
  });

  it('editar cualquier otra columna falla con 42501, aunque se retire a la vez', async () => {
    const id = await createDocument();

    await expect(
      sqlState(
        prisma.$executeRawUnsafe(
          `update public.patient_documents set title = 'Otro', withdrawn_at = now() where id = '${id}'`,
        ),
      ),
    ).resolves.toBe('42501');
  });

  it('DELETE falla con 42501', async () => {
    const id = await createDocument();

    await expect(
      sqlState(
        prisma.$executeRawUnsafe(
          `delete from public.patient_documents where id = '${id}'`,
        ),
      ),
    ).resolves.toBe('42501');
  });

  it('TRUNCATE falla con 42501', async () => {
    await createDocument();

    await expect(
      sqlState(prisma.$executeRawUnsafe('truncate public.patient_documents')),
    ).resolves.toBe('42501');
  });
});
