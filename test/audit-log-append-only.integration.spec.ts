import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * Audit log inmutable contra Postgres real (ENG-87).
 *
 * Las reglas viven en triggers, así que solo se pueden probar contra una base de
 * verdad. `prisma db push` arma el esquema pero no corre el SQL de las
 * migraciones: este spec carga la de ENG-87 statement por statement, igual que
 * el de ENG-126 con la suya.
 *
 * Deshace los triggers al terminar: los specs de integración comparten base, y
 * sin eso ningún otro spec podría limpiar las filas de auditoría que deje.
 */

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261013120000_eng87_audit_log_append_only',
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

/** El error de Postgres que trae Prisma, para mirar el código y el mensaje. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
  }
  throw new Error('La operación debía fallar y no falló');
}

describe('Audit log inmutable (integration)', () => {
  const prisma = new PrismaClient();
  const actor = randomUUID();
  const patient = randomUUID();
  let auditId: string;
  let accessLogId: string;
  let sessionId: string;
  let codeId: string;

  beforeAll(async () => {
    await prisma.profile.create({
      data: {
        id: actor,
        email: `pro-${actor}@test.local`,
        role: 'PROFESIONAL',
      },
    });
    await prisma.profile.create({
      data: {
        id: patient,
        email: `pac-${patient}@test.local`,
        role: 'PACIENTE',
      },
    });
    await prisma.patient.create({
      data: { profile_id: patient, first_name: 'Test', last_name: 'Auditoría' },
    });

    await applyMigration(prisma, MIGRATION);
    await applyMigration(prisma, MIGRATION); // idempotente: se puede aplicar dos veces

    const audit = await prisma.auditLog.create({
      data: {
        actor_id: actor,
        action: 'CLINICAL_RECORD_READ',
        resource_type: 'clinical_record',
        resource_id: patient,
      },
    });
    auditId = audit.id;

    const code = await prisma.mediPassCode.create({
      data: {
        patient_id: patient,
        code: '12345678',
        expires_at: new Date(Date.now() + 5 * 60_000),
      },
    });
    codeId = code.id;
    const session = await prisma.mediPassSession.create({
      data: {
        patient_id: patient,
        medipass_code_id: code.id,
        consultant_name: 'Dra. Test',
        consultant_license: 'MP-0000',
        expires_at: new Date(Date.now() + 30 * 60_000),
      },
    });
    sessionId = session.id;
    const access = await prisma.mediPassAccessLog.create({
      data: {
        session_id: session.id,
        patient_id: patient,
        resource_accessed: 'vital',
      },
    });
    accessLogId = access.id;
  }, 60_000);

  afterAll(async () => {
    for (const sql of [
      'drop trigger if exists audit_logs_no_mutation on public.audit_logs',
      'drop trigger if exists audit_logs_no_truncate on public.audit_logs',
      'drop trigger if exists medipass_access_logs_no_mutation on public.medipass_access_logs',
      'drop trigger if exists medipass_access_logs_no_truncate on public.medipass_access_logs',
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }

    await prisma.mediPassAccessLog.deleteMany({
      where: { patient_id: patient },
    });
    await prisma.mediPassSession.deleteMany({ where: { id: sessionId } });
    await prisma.mediPassCode.deleteMany({ where: { id: codeId } });
    await prisma.auditLog.deleteMany({ where: { actor_id: actor } });
    await prisma.patient.deleteMany({ where: { profile_id: patient } });
    await prisma.profile.deleteMany({
      where: { id: { in: [actor, patient] } },
    });

    await prisma.$disconnect();
  });

  describe('audit_logs', () => {
    it('se puede agregar un registro', async () => {
      await expect(
        prisma.auditLog.create({
          data: {
            actor_id: actor,
            action: 'CLINICAL_RECORD_READ',
            resource_type: 'clinical_record',
          },
        }),
      ).resolves.toMatchObject({ actor_id: actor });
    });

    it('no se puede modificar un registro', async () => {
      const error = await failure(
        prisma.auditLog.update({
          where: { id: auditId },
          data: { action: 'NADA_QUE_VER' },
        }),
      );

      expect(error).toMatch(/audit_logs es append-only: UPDATE no permitido/);
    });

    it('no se puede borrar un registro', async () => {
      const error = await failure(
        prisma.auditLog.delete({ where: { id: auditId } }),
      );

      expect(error).toMatch(/audit_logs es append-only: DELETE no permitido/);
    });

    it('no se puede vaciar con TRUNCATE', async () => {
      const error = await failure(
        prisma.$executeRawUnsafe('truncate table public.audit_logs'),
      );

      expect(error).toMatch(/append-only: TRUNCATE no permitido/);
    });

    it('un TRUNCATE en cascada desde profiles tampoco la vacía', async () => {
      // Dentro de una transacción que SIEMPRE hace rollback: si el trigger
      // tuviera una regresión, el truncate no vacía `profiles` en la base
      // compartida de test.
      const error = await failure(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('truncate table public.profiles cascade');
          throw new Error('el truncate pasó: rollback');
        }),
      );

      expect(error).toMatch(/append-only: TRUNCATE no permitido/);
      await expect(
        prisma.auditLog.count({ where: { id: auditId } }),
      ).resolves.toBe(1);
    });

    it('no se puede borrar un perfil que tiene accesos auditados', async () => {
      // Con el SET NULL de antes, el borrado pasaba y el registro perdía quién
      // accedió. Ahora lo frena la FK.
      const error = await failure(
        prisma.profile.delete({ where: { id: actor } }),
      );

      expect(error).toMatch(/audit_logs_actor_id_fkey|Foreign key constraint/i);
      await expect(
        prisma.auditLog.findUnique({ where: { id: auditId } }),
      ).resolves.toMatchObject({ actor_id: actor });
    });
  });

  describe('medipass_access_logs', () => {
    it('no se puede modificar un acceso', async () => {
      const error = await failure(
        prisma.mediPassAccessLog.update({
          where: { id: accessLogId },
          data: { resource_accessed: 'otra cosa' },
        }),
      );

      expect(error).toMatch(
        /medipass_access_logs es append-only: UPDATE no permitido/,
      );
    });

    it('no se puede borrar un acceso', async () => {
      const error = await failure(
        prisma.mediPassAccessLog.delete({ where: { id: accessLogId } }),
      );

      expect(error).toMatch(
        /medipass_access_logs es append-only: DELETE no permitido/,
      );
    });

    it('no se puede vaciar con TRUNCATE', async () => {
      const error = await failure(
        prisma.$executeRawUnsafe('truncate table public.medipass_access_logs'),
      );

      expect(error).toMatch(/append-only: TRUNCATE no permitido/);
    });
  });
});
