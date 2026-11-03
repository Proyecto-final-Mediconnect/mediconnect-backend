import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * Canal privado del "está escribiendo…" (ENG-70), contra Postgres real.
 *
 * Supabase Realtime decide si un usuario puede recibir o mandar en un canal
 * privado haciendo `select` / `insert` sobre `realtime.messages` como ese
 * usuario, con `realtime.topic()` devolviendo el canal. Este Postgres no tiene
 * Realtime, así que el spec arma una tabla y una función con la misma forma y
 * prueba las políticas de la migración sobre ellas.
 */

const migration = (name: string) =>
  join(__dirname, '..', 'prisma', 'migrations', name, 'migration.sql');
const CHAT_RLS = migration('20261026120000_eng70_chat_rls');
const TYPING = migration('20261102120000_eng70_chat_typing');

/** Carga un archivo de migración statement por statement (separador `--;;`). */
async function applyMigration(prisma: PrismaClient, path: string) {
  for (const statement of readFileSync(path, 'utf8').split(
    /^--;;[ \t]*\r?$/m,
  )) {
    const sql = statement.trim();
    if (sql.length > 0) await prisma.$executeRawUnsafe(sql);
  }
}

describe('Canal de "escribiendo" del chat (integration)', () => {
  const prisma = new PrismaClient();

  const patient = randomUUID();
  const professional = randomUUID();
  const outsider = randomUUID();
  let topic: string;

  beforeAll(async () => {
    // Piezas que en producción trae Supabase y este Postgres no tiene.
    await prisma.$executeRawUnsafe(`
      do $$ begin
        create role authenticated nologin noinherit;
      exception when duplicate_object then null; end $$`);
    await prisma.$executeRawUnsafe('create schema if not exists auth');
    await prisma.$executeRawUnsafe(`
      create or replace function auth.uid() returns uuid as $$
        select nullif(
          current_setting('request.jwt.claims', true)::json ->> 'sub',
          ''
        )::uuid
      $$ language sql stable`);
    await prisma.$executeRawUnsafe('create schema if not exists realtime');
    await prisma.$executeRawUnsafe(`
      create table if not exists realtime.messages (
        id bigserial primary key,
        topic text not null,
        extension text not null,
        event text,
        payload jsonb
      )`);
    await prisma.$executeRawUnsafe(
      'alter table realtime.messages enable row level security',
    );
    await prisma.$executeRawUnsafe(`
      create or replace function realtime.topic() returns text as $$
        select nullif(current_setting('realtime.topic', true), '')
      $$ language sql stable`);
    for (const sql of [
      'grant usage on schema public to authenticated',
      'grant usage on schema auth to authenticated',
      'grant usage on schema realtime to authenticated',
      'grant select, insert on realtime.messages to authenticated',
      'grant usage on sequence realtime.messages_id_seq to authenticated',
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }

    await applyMigration(prisma, CHAT_RLS);
    await applyMigration(prisma, TYPING);

    for (const [id, role] of [
      [patient, 'PACIENTE'],
      [outsider, 'PACIENTE'],
      [professional, 'PROFESIONAL'],
    ] as const) {
      await prisma.profile.create({
        data: { id, email: `typing-${id}@test.local`, role },
      });
    }
    for (const id of [patient, outsider]) {
      await prisma.patient.create({
        data: { profile_id: id, first_name: 'Test', last_name: 'Typing' },
      });
    }
    await prisma.professional.create({
      data: {
        profile_id: professional,
        first_name: 'Test',
        last_name: 'Typing',
        license_number: `MP-${professional.slice(0, 8)}`,
      },
    });

    const conversation = await prisma.conversation.create({
      data: { patient_id: patient, professional_id: professional },
    });
    topic = `typing:${conversation.id}`;
    await prisma.$executeRaw`
      insert into realtime.messages (topic, extension, event)
      values (${topic}, 'broadcast', 'escribiendo')`;
  }, 60_000);

  afterAll(async () => {
    await prisma.conversation.deleteMany({
      where: { patient_id: { in: [patient, outsider] } },
    });
    await prisma.patient.deleteMany({
      where: { profile_id: { in: [patient, outsider] } },
    });
    await prisma.professional.deleteMany({
      where: { profile_id: professional },
    });
    await prisma.profile.deleteMany({
      where: { id: { in: [patient, outsider, professional] } },
    });

    for (const sql of [
      'drop schema if exists realtime cascade',
      'drop policy if exists messages_select_participants on public.messages',
      'drop policy if exists conversations_select_participants on public.conversations',
      'alter table public.messages disable row level security',
      'alter table public.conversations disable row level security',
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    await prisma.$disconnect();
  });

  /** Corre `work` como el usuario en el canal `channel`, como lo evalúa Realtime. */
  function asUserOn<T>(
    userId: string,
    channel: string,
    work: (tx: PrismaClient) => Promise<T>,
  ) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('set local role authenticated');
      await tx.$executeRawUnsafe(
        `select set_config('request.jwt.claims', '{"sub":"${userId}"}', true)`,
      );
      await tx.$executeRaw`select set_config('realtime.topic', ${channel}, true)`;
      return work(tx as unknown as PrismaClient);
    });
  }

  const receive = (tx: PrismaClient) =>
    tx.$queryRaw<
      { n: bigint }[]
    >`select count(*) as n from realtime.messages where topic = ${topic}`;

  const send = (tx: PrismaClient) =>
    tx.$executeRaw`
      insert into realtime.messages (topic, extension, event)
      values (${topic}, 'broadcast', 'escribiendo')`;

  it.each([
    ['el paciente', () => patient],
    ['el profesional', () => professional],
  ])('%s puede escuchar y avisar en su conversación', async (_, who) => {
    const [{ n }] = await asUserOn(who(), topic, receive);
    expect(Number(n)).toBeGreaterThan(0);

    await expect(asUserOn(who(), topic, send)).resolves.toBe(1);
  });

  it('otra persona no puede escuchar ni avisar, aunque sepa el id', async () => {
    const [{ n }] = await asUserOn(outsider, topic, receive);
    expect(Number(n)).toBe(0);

    await expect(asUserOn(outsider, topic, send)).rejects.toThrow(
      /row-level security/,
    );
  });

  it('un canal que no es de "escribiendo" no queda abierto por estas políticas', async () => {
    const other = `conversation:${topic.slice('typing:'.length)}`;
    await prisma.$executeRaw`
      insert into realtime.messages (topic, extension, event)
      values (${other}, 'broadcast', 'otro')`;

    const [{ n }] = await asUserOn(
      patient,
      other,
      (tx) =>
        tx.$queryRaw<
          { n: bigint }[]
        >`select count(*) as n from realtime.messages where topic = ${other}`,
    );
    expect(Number(n)).toBe(0);
  });

  it('la migración se puede volver a correr sin romper nada', async () => {
    await expect(applyMigration(prisma, TYPING)).resolves.toBeUndefined();
  });
});
