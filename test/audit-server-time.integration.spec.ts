import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * La hora de las bitácoras la pone el servidor (ENG-145).
 *
 * ENG-87 dejó `audit_logs` y `medipass_access_logs` append-only, pero la fecha
 * seguía siendo un dato del cliente: el `default now()` solo actúa si la columna
 * se omite, y Prisma la manda explícitamente cuando el código se la pasa. Una
 * fila inmutable fechada en el pasado no prueba nada.
 *
 * Esto **solo se puede verificar contra Postgres real**: el trigger vive en la
 * base y un mock de Prisma devolvería lo que uno le diga.
 *
 * El spec carga el archivo de migración statement por statement, igual que los
 * de ENG-57, ENG-126 y ENG-170, porque el CI de integración prepara la base con
 * `prisma db push` y **no ejecuta las migraciones**: sin esto, el SQL de este
 * cambio correría por primera vez en el deploy a producción.
 */

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261104150000_eng145_hora_servidor_bitacoras',
  'migration.sql',
);

/** Una fecha bien en el pasado: si sobrevive, el trigger no actuó. */
const HACE_UN_MES = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

async function applyMigration(prisma: PrismaClient, path: string) {
  for (const statement of readFileSync(path, 'utf8').split(
    /^--;;[ \t]*\r?$/m,
  )) {
    const sql = statement.trim();
    if (sql.length > 0) await prisma.$executeRawUnsafe(sql);
  }
}

describe('Hora del servidor en las bitácoras (integration)', () => {
  const prisma = new PrismaClient();

  // `patients.profile_id` ES el id del profile: una sola constante alcanza.
  const PROFILE = randomUUID();
  const CODE = randomUUID();
  const SESSION = randomUUID();

  beforeAll(async () => {
    await applyMigration(prisma, MIGRATION);

    // `audit_logs.actor_id` y `medipass_access_logs.patient_id` son FK reales.
    await prisma.profile.create({
      data: {
        id: PROFILE,
        email: `eng145-${PROFILE}@test.local`,
        role: 'PACIENTE',
      },
    });
    await prisma.patient.create({
      data: {
        profile_id: PROFILE,
        first_name: 'Test',
        last_name: 'ServerTime',
      },
    });
    await prisma.mediPassCode.create({
      data: {
        id: CODE,
        patient_id: PROFILE,
        code: 'ZZ234567',
        expires_at: new Date(Date.now() + 5 * 60_000),
      },
    });
    await prisma.mediPassSession.create({
      data: {
        id: SESSION,
        patient_id: PROFILE,
        medipass_code_id: CODE,
        consultant_name: 'Dr. Integration',
        expires_at: new Date(Date.now() + 30 * 60_000),
      },
    });
  });

  /**
   * Prende o apaga el trigger append-only de ENG-87, **si existe**.
   *
   * No se puede asumir que esté. El CI de integración prepara la base con
   * `prisma db push`, que deriva el esquema del `schema.prisma` y **no ejecuta
   * las migraciones**: ahí los triggers de ENG-87 no existen y un
   * `alter table ... disable trigger` pelado falla con `42704`. Contra una base
   * donde sí se corrió `migrate deploy` existen, y hay que apagarlos para poder
   * limpiar.
   *
   * PostgreSQL no tiene `DISABLE TRIGGER IF EXISTS`, así que el chequeo va a
   * mano contra `pg_trigger`.
   */
  async function appendOnlyTrigger(
    tabla: string,
    accion: 'disable' | 'enable always',
  ): Promise<void> {
    await prisma.$executeRawUnsafe(`
      do $$
      begin
        if exists (
          select 1 from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
           where c.relname = '${tabla}'
             and t.tgname = '${tabla}_no_mutation'
        ) then
          alter table public.${tabla} ${accion} trigger ${tabla}_no_mutation;
        end if;
      end $$;
    `);
  }

  afterAll(async () => {
    // Las dos bitácoras son append-only: para limpiar hay que apagar el trigger
    // de ENG-87 donde esté puesto.
    for (const t of ['audit_logs', 'medipass_access_logs']) {
      await appendOnlyTrigger(t, 'disable');
    }
    await prisma.mediPassAccessLog.deleteMany({
      where: { patient_id: PROFILE },
    });
    await prisma.auditLog.deleteMany({ where: { actor_id: PROFILE } });
    for (const t of ['audit_logs', 'medipass_access_logs']) {
      await appendOnlyTrigger(t, 'enable always');
    }
    await prisma.mediPassSession.deleteMany({ where: { patient_id: PROFILE } });
    await prisma.mediPassCode.deleteMany({ where: { patient_id: PROFILE } });
    await prisma.patient.deleteMany({ where: { profile_id: PROFILE } });
    await prisma.profile.deleteMany({ where: { id: PROFILE } });
    await prisma.$disconnect();
  });

  /** Margen para la diferencia entre el reloj del test y el de Postgres. */
  const MARGEN_MS = 60_000;

  function esDeAhora(fecha: Date): boolean {
    return Math.abs(Date.now() - fecha.getTime()) < MARGEN_MS;
  }

  describe('audit_logs.created_at', () => {
    it('un INSERT con fecha en el pasado queda con la hora del servidor', async () => {
      const fila = await prisma.auditLog.create({
        data: {
          actor_id: PROFILE,
          action: 'CLINICAL_RECORD_READ',
          resource_type: 'clinical_record_entries',
          resource_id: PROFILE,
          created_at: HACE_UN_MES,
        },
        select: { id: true, created_at: true },
      });

      expect(fila.created_at.getTime()).toBeGreaterThan(HACE_UN_MES.getTime());
      expect(esDeAhora(fila.created_at)).toBe(true);
    });

    it('tampoco se puede fechar en el futuro', async () => {
      // El otro lado del mismo problema: adelantar la fecha de un acceso sirve
      // para armar una coartada igual que atrasarla sirve para esconderlo.
      const enUnMes = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const fila = await prisma.auditLog.create({
        data: {
          actor_id: PROFILE,
          action: 'CLINICAL_RECORD_READ',
          resource_type: 'clinical_record_entries',
          created_at: enUnMes,
        },
        select: { created_at: true },
      });

      expect(fila.created_at.getTime()).toBeLessThan(enUnMes.getTime());
      expect(esDeAhora(fila.created_at)).toBe(true);
    });

    it('sin fecha explícita sigue funcionando', async () => {
      const fila = await prisma.auditLog.create({
        data: {
          actor_id: PROFILE,
          action: 'MEDIPASS_ACCESS_REVOKED',
          resource_type: 'medipass_sessions',
        },
        select: { created_at: true },
      });

      expect(esDeAhora(fila.created_at)).toBe(true);
    });
  });

  describe('medipass_access_logs.accessed_at', () => {
    it('un INSERT con fecha en el pasado queda con la hora del servidor', async () => {
      const fila = await prisma.mediPassAccessLog.create({
        data: {
          session_id: SESSION,
          patient_id: PROFILE,
          resource_accessed: 'alergias',
          accessed_at: HACE_UN_MES,
        },
        select: { accessed_at: true },
      });

      expect(fila.accessed_at.getTime()).toBeGreaterThan(HACE_UN_MES.getTime());
      expect(esDeAhora(fila.accessed_at)).toBe(true);
    });

    it('sin fecha explícita sigue funcionando', async () => {
      const fila = await prisma.mediPassAccessLog.create({
        data: {
          session_id: SESSION,
          patient_id: PROFILE,
          resource_accessed: 'medicacion_activa',
        },
        select: { accessed_at: true },
      });

      expect(esDeAhora(fila.accessed_at)).toBe(true);
    });
  });

  describe('la migración', () => {
    it('es idempotente: aplicarla dos veces no falla', async () => {
      await expect(applyMigration(prisma, MIGRATION)).resolves.toBeUndefined();
    });

    it('los triggers quedan en `always`, no en `origin`', async () => {
      // Con `enable trigger` a secas, una sesión con
      // `session_replication_role = replica` los saltearía — y el rol
      // `postgres` de Supabase puede setearlo. Es el mismo criterio de ENG-87.
      const filas = await prisma.$queryRawUnsafe<
        { tgname: string; tgenabled: string }[]
      >(
        `select t.tgname, t.tgenabled
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
          where c.relname in ('audit_logs', 'medipass_access_logs')
            and t.tgname like '%_stamp_server_time'`,
      );

      expect(filas).toHaveLength(2);
      for (const f of filas) expect(f.tgenabled).toBe('A');
    });
  });
});
