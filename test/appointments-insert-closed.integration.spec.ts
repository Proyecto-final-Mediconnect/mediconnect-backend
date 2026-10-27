import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * ENG-175 — un paciente no puede insertar turnos por PostgREST.
 *
 * Se arma el mismo estado que dejó ENG-54 en producción (el rol `authenticated`,
 * `auth.uid()`, el GRANT de INSERT y su policy), se verifica que el agujero
 * existía, y después se aplica la migración de ENG-175 y se verifica que ya no.
 * El harness del rol y de `auth.uid()` es el de
 * `clinical-records.integration.spec.ts`.
 *
 * **Se limpia solo:** el `afterAll` saca los GRANTs, las policies y la RLS que
 * puso, porque los specs de integración comparten base.
 */

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261022130000_eng175_revoke_appointments_insert',
  'migration.sql',
);

describe('INSERT directo sobre appointments (integration)', () => {
  const prisma = new PrismaClient();

  const patientId = randomUUID();
  const professionalId = randomUUID();
  let slot = 0;

  /**
   * Corre `work` como el paciente autenticado: rol `authenticated` y claim
   * `sub`, con `SET LOCAL` para no contaminar la conexión del pool.
   */
  function asPatient<T>(work: (tx: PrismaClient) => Promise<T>) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('set local role authenticated');
      await tx.$executeRawUnsafe(
        `select set_config('request.jwt.claims', '{"sub":"${patientId}"}', true)`,
      );
      return work(tx as unknown as PrismaClient);
    });
  }

  /** El INSERT que haría un paciente por PostgREST: confirmado y a $1. */
  function forgedBooking(tx: PrismaClient) {
    slot += 1;
    return tx.$executeRawUnsafe(
      `insert into public.appointments
         (patient_id, professional_id, scheduled_at, duration_minutes, price, status)
       values ($1::uuid, $2::uuid, now() + ($3 || ' days')::interval, 30, 1,
               'CONFIRMADO'::appointment_status)`,
      patientId,
      professionalId,
      String(slot),
    );
  }

  beforeAll(async () => {
    await prisma.profile.createMany({
      data: [
        { id: patientId, email: `p-${patientId}@test.local`, role: 'PACIENTE' },
        {
          id: professionalId,
          email: `pro-${professionalId}@test.local`,
          role: 'PROFESIONAL',
        },
      ],
    });
    await prisma.patient.create({
      data: {
        profile_id: patientId,
        first_name: 'Test',
        last_name: 'Paciente',
      },
    });
    await prisma.professional.create({
      data: {
        profile_id: professionalId,
        first_name: 'Test',
        last_name: 'Profesional',
        license_number: `MP-${professionalId.slice(0, 8)}`,
      },
    });

    // Piezas que en producción trae Supabase.
    await prisma.$executeRawUnsafe(`
      do $$ begin
        create role authenticated nologin noinherit;
      exception when duplicate_object then null; end $$`);
    await prisma.$executeRawUnsafe(`
      do $$ begin
        create role anon nologin noinherit;
      exception when duplicate_object then null; end $$`);
    await prisma.$executeRawUnsafe('create schema if not exists auth');
    await prisma.$executeRawUnsafe(`
      create or replace function auth.uid() returns uuid as $$
        select nullif(
          current_setting('request.jwt.claims', true)::json ->> 'sub',
          ''
        )::uuid
      $$ language sql stable`);
    await prisma.$executeRawUnsafe(
      'grant usage on schema public to authenticated',
    );

    // El estado que dejó ENG-54, más los default privileges de Supabase
    // (MAINTAIN sólo existe desde Postgres 17).
    await prisma.$executeRawUnsafe(
      'grant select, insert on public.appointments to authenticated',
    );
    await prisma.$executeRawUnsafe(
      'grant truncate, references, trigger on public.appointments to authenticated, anon',
    );
    const [{ pg_version }] = await prisma.$queryRaw<
      { pg_version: number }[]
    >`select current_setting('server_version_num')::int as pg_version`;
    if (pg_version >= 170000) {
      await prisma.$executeRawUnsafe(
        'grant maintain on public.appointments to authenticated, anon',
      );
    }
    await prisma.$executeRawUnsafe(
      'alter table public.appointments enable row level security',
    );
    for (const sql of [
      'drop policy if exists appointments_select_own on public.appointments',
      `create policy appointments_select_own on public.appointments
         for select to authenticated
         using (patient_id = auth.uid() or professional_id = auth.uid())`,
      'drop policy if exists appointments_insert_own_patient on public.appointments',
      `create policy appointments_insert_own_patient on public.appointments
         for insert to authenticated
         with check (patient_id = auth.uid())`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  });

  afterAll(async () => {
    for (const sql of [
      'drop policy if exists appointments_select_own on public.appointments',
      'drop policy if exists appointments_insert_own_patient on public.appointments',
      'alter table public.appointments disable row level security',
      'revoke all on public.appointments from authenticated, anon',
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    await prisma.appointment.deleteMany({ where: { patient_id: patientId } });
    await prisma.professional.deleteMany({
      where: { profile_id: professionalId },
    });
    await prisma.patient.deleteMany({ where: { profile_id: patientId } });
    await prisma.profile.deleteMany({
      where: { id: { in: [patientId, professionalId] } },
    });
    await prisma.$disconnect();
  });

  it('con el estado de ENG-54, el paciente reservaba CONFIRMADO y a $1', async () => {
    // Si esto dejara de pasar, el resto del spec no estaría probando nada.
    await expect(asPatient(forgedBooking)).resolves.toBe(1);
  });

  it('después de ENG-175 el INSERT directo se rechaza', async () => {
    for (const statement of readFileSync(MIGRATION, 'utf8').split(
      /^--;;[ \t]*\r?$/m,
    )) {
      const sql = statement.trim();
      if (sql.length > 0) await prisma.$executeRawUnsafe(sql);
    }

    await expect(asPatient(forgedBooking)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('a anon y authenticated no les queda TRUNCATE, ni a anon nada', async () => {
    const grants = await prisma.$queryRaw<
      { grantee: string; privilege_type: string }[]
    >`
      select grantee, privilege_type
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'appointments'
         and grantee in ('anon', 'authenticated')`;

    expect(grants).toEqual([
      { grantee: 'authenticated', privilege_type: 'SELECT' },
    ]);
  });

  it('el paciente sigue leyendo sus turnos', async () => {
    const rows = await asPatient(
      (tx) =>
        tx.$queryRaw<{ n: bigint }[]>`
        select count(*) as n from public.appointments
         where patient_id = ${patientId}::uuid`,
    );

    // El que entró antes de la migración.
    expect(Number(rows[0].n)).toBe(1);
  });
});
