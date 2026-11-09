import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * La verificación en dos pasos exigida por la base (ENG-88), contra Postgres
 * real:
 *
 * - `profiles.mfa_enabled` no lo puede cambiar el usuario por PostgREST.
 * - Con un token sin el segundo paso (`aal1`), quien activó la verificación no
 *   lee nada por la RLS; quien no la activó, sí.
 *
 * Este Postgres no tiene Supabase Auth: el spec arma `auth.jwt()`,
 * `auth.uid()` y una `auth.mfa_factors` con las columnas que lee
 * `public.mfa_ok()`. La RLS del chat (ENG-70) sirve de política permisiva sobre
 * la que se suma la restrictiva.
 */

const migration = (name: string) =>
  join(__dirname, '..', 'prisma', 'migrations', name, 'migration.sql');
const CHAT_RLS = migration('20261026120000_eng70_chat_rls');
const MFA_RLS = migration('20261109120000_eng88_mfa_rls');

/** Carga un archivo de migración statement por statement (separador `--;;`). */
async function applyMigration(prisma: PrismaClient, path: string) {
  for (const statement of readFileSync(path, 'utf8').split(
    /^--;;[ \t]*\r?$/m,
  )) {
    const sql = statement.trim();
    if (sql.length > 0) await prisma.$executeRawUnsafe(sql);
  }
}

describe('Verificación en dos pasos en la base (integration)', () => {
  const prisma = new PrismaClient();

  /** Tiene la verificación activa (factor verificado). */
  const conMfa = randomUUID();
  /** Empezó el alta y no la terminó (factor sin verificar). */
  const aMedias = randomUUID();
  let conversationId: string;
  let creoMfaFactors = false;

  beforeAll(async () => {
    // Piezas que en producción trae Supabase y este Postgres no tiene.
    await prisma.$executeRawUnsafe(`
      do $$ begin
        create role authenticated nologin noinherit;
      exception when duplicate_object then null; end $$`);
    await prisma.$executeRawUnsafe('create schema if not exists auth');
    await prisma.$executeRawUnsafe(`
      create or replace function auth.jwt() returns jsonb as $$
        select coalesce(
          nullif(current_setting('request.jwt.claims', true), '')::jsonb,
          '{}'::jsonb
        )
      $$ language sql stable`);
    await prisma.$executeRawUnsafe(`
      create or replace function auth.uid() returns uuid as $$
        select nullif(
          current_setting('request.jwt.claims', true)::json ->> 'sub',
          ''
        )::uuid
      $$ language sql stable`);
    creoMfaFactors =
      (
        await prisma.$queryRaw<{ t: string | null }[]>`
          select to_regclass('auth.mfa_factors')::text as t`
      )[0].t === null;
    await prisma.$executeRawUnsafe(`
      create table if not exists auth.mfa_factors (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null,
        factor_type text not null,
        status text not null
      )`);
    for (const sql of [
      'grant usage on schema public to authenticated',
      'grant usage on schema auth to authenticated',
      'grant select, update on public.profiles to authenticated',
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }

    await applyMigration(prisma, CHAT_RLS);
    await applyMigration(prisma, MFA_RLS);

    await prisma.profile.create({
      data: { id: conMfa, email: `mfa-${conMfa}@test.local`, role: 'PACIENTE' },
    });
    await prisma.profile.create({
      data: {
        id: aMedias,
        email: `mfa-${aMedias}@test.local`,
        role: 'PROFESIONAL',
      },
    });
    await prisma.patient.create({
      data: { profile_id: conMfa, first_name: 'Test', last_name: 'Mfa' },
    });
    await prisma.professional.create({
      data: {
        profile_id: aMedias,
        first_name: 'Test',
        last_name: 'Mfa',
        license_number: `MP-${aMedias.slice(0, 8)}`,
      },
    });
    const conversation = await prisma.conversation.create({
      data: { patient_id: conMfa, professional_id: aMedias },
    });
    conversationId = conversation.id;
    await prisma.message.create({
      data: {
        conversation_id: conversationId,
        sender_id: conMfa,
        content: 'Hola',
      },
    });

    await prisma.$executeRaw`
      insert into auth.mfa_factors (user_id, factor_type, status)
      values (${conMfa}::uuid, 'totp', 'verified'),
             (${aMedias}::uuid, 'totp', 'unverified')`;
  }, 60_000);

  afterAll(async () => {
    await prisma.$executeRaw`
      delete from auth.mfa_factors where user_id in (${conMfa}::uuid, ${aMedias}::uuid)`;
    await prisma.conversation.deleteMany({ where: { patient_id: conMfa } });
    await prisma.patient.deleteMany({ where: { profile_id: conMfa } });
    await prisma.professional.deleteMany({ where: { profile_id: aMedias } });
    await prisma.profile.deleteMany({
      where: { id: { in: [conMfa, aMedias] } },
    });

    // Las políticas que dejó la migración, en todas las tablas donde las creó.
    const conPolitica = await prisma.$queryRaw<{ tablename: string }[]>`
      select tablename from pg_policies
       where schemaname = 'public' and policyname = 'mfa_aal2_required'`;
    for (const { tablename } of conPolitica) {
      await prisma.$executeRawUnsafe(
        `drop policy if exists mfa_aal2_required on public."${tablename}"`,
      );
    }
    for (const sql of [
      'drop policy if exists messages_select_participants on public.messages',
      'drop policy if exists conversations_select_participants on public.conversations',
      'alter table public.messages disable row level security',
      'alter table public.conversations disable row level security',
      'drop trigger if exists profiles_prevent_mfa_change on public.profiles',
      'drop function if exists public.prevent_profile_mfa_change()',
      'drop function if exists public.mfa_ok()',
      'revoke update on public.profiles from authenticated',
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    if (creoMfaFactors) {
      await prisma.$executeRawUnsafe('drop table if exists auth.mfa_factors');
    }
    await prisma.$disconnect();
  });

  /** Corre `work` como `authenticated`, con el `sub` y el `aal` del JWT. */
  function asUser<T>(
    userId: string,
    aal: 'aal1' | 'aal2',
    work: (tx: PrismaClient) => Promise<T>,
  ) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('set local role authenticated');
      await tx.$executeRawUnsafe(
        `select set_config('request.jwt.claims', '{"sub":"${userId}","aal":"${aal}","role":"authenticated"}', true)`,
      );
      return work(tx as unknown as PrismaClient);
    });
  }

  const countMessages = async (tx: PrismaClient) =>
    Number(
      (
        await tx.$queryRaw<{ n: bigint }[]>`
          select count(*) as n from messages
           where conversation_id = ${conversationId}::uuid`
      )[0].n,
    );

  /** SQLSTATE de un error de Postgres, venga como venga envuelto. */
  async function sqlState(promesa: Promise<unknown>): Promise<string> {
    try {
      await promesa;
    } catch (error) {
      const e = error as { code?: string; meta?: { code?: string } };
      return (
        e.meta?.code ??
        String((error as Error).message).match(/\b(42501)\b/)?.[1] ??
        e.code ??
        'desconocido'
      );
    }
    return 'sin error';
  }

  describe('profiles.mfa_enabled', () => {
    it('el usuario no la puede apagar por PostgREST', async () => {
      await prisma.profile.update({
        where: { id: conMfa },
        data: { mfa_enabled: true },
      });

      await expect(
        sqlState(
          asUser(
            conMfa,
            'aal2',
            (tx) => tx.$executeRaw`
              update profiles set mfa_enabled = false where id = ${conMfa}::uuid`,
          ),
        ),
      ).resolves.toBe('42501');

      const profile = await prisma.profile.findUniqueOrThrow({
        where: { id: conMfa },
      });
      expect(profile.mfa_enabled).toBe(true);
    });

    it('ni prenderla', async () => {
      await expect(
        sqlState(
          asUser(
            aMedias,
            'aal1',
            (tx) => tx.$executeRaw`
              update profiles set mfa_enabled = true where id = ${aMedias}::uuid`,
          ),
        ),
      ).resolves.toBe('42501');
    });

    it('el resto de su perfil lo sigue pudiendo cambiar', async () => {
      const n = await asUser(
        aMedias,
        'aal1',
        (tx) => tx.$executeRaw`
          update profiles set email_reminders = false where id = ${aMedias}::uuid`,
      );
      expect(n).toBe(1);
    });

    it('el backend (dueño de la tabla) sí la cambia', async () => {
      await prisma.profile.update({
        where: { id: conMfa },
        data: { mfa_enabled: false },
      });
      await prisma.profile.update({
        where: { id: conMfa },
        data: { mfa_enabled: true },
      });
    });
  });

  describe('RLS según el aal del token', () => {
    it('con la verificación activa y solo la contraseña (aal1) no ve nada', async () => {
      await expect(asUser(conMfa, 'aal1', countMessages)).resolves.toBe(0);
    });

    it('con el segundo paso hecho (aal2) ve lo suyo', async () => {
      await expect(asUser(conMfa, 'aal2', countMessages)).resolves.toBe(1);
    });

    it('un factor sin verificar no cuenta: con aal1 ve lo suyo', async () => {
      await expect(asUser(aMedias, 'aal1', countMessages)).resolves.toBe(1);
    });

    it('mfa_ok() sigue la misma regla', async () => {
      const ok = (userId: string, aal: 'aal1' | 'aal2') =>
        asUser(userId, aal, async (tx) => {
          const [{ v }] = await tx.$queryRaw<
            { v: boolean }[]
          >`select public.mfa_ok() as v`;
          return v;
        });

      await expect(ok(conMfa, 'aal1')).resolves.toBe(false);
      await expect(ok(conMfa, 'aal2')).resolves.toBe(true);
      await expect(ok(aMedias, 'aal1')).resolves.toBe(true);
    });

    it('la política es restrictiva y está en las tablas sensibles', async () => {
      const filas = await prisma.$queryRaw<
        { tablename: string; permissive: string; roles: string[] }[]
      >`
        select tablename, permissive, roles::text[] as roles from pg_policies
         where schemaname = 'public' and policyname = 'mfa_aal2_required'`;
      const tablas = filas.map((f) => f.tablename);

      for (const t of [
        'profiles',
        'patients',
        'appointments',
        'payments',
        'clinical_record_entries',
        'messages',
        'patient_documents',
      ]) {
        expect(tablas).toContain(t);
      }
      for (const f of filas) {
        expect(f.permissive).toBe('RESTRICTIVE');
        expect(f.roles).toEqual(['authenticated']);
      }
    });
  });
});
