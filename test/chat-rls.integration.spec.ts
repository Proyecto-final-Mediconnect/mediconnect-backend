import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * RLS de `conversations` y `messages` contra Postgres real (ENG-70).
 *
 * Es lo que Realtime evalúa por cada suscriptor antes de entregarle un mensaje:
 * si un `select` como `authenticated` no ve la fila, el WebSocket tampoco la
 * manda. Realtime en sí no existe en este Postgres (ver el spike ENG-52), así
 * que esto cubre la política y no el transporte. El aislamiento de punta a punta
 * por Realtime quedó validado en el spike contra el proyecto real.
 *
 * `prisma db push` crea las tablas sin la migración, por eso este spec la aplica
 * y la deshace al terminar, igual que el de endurecimiento de la HC.
 */

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261026120000_eng70_chat_rls',
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

describe('RLS del chat (integration)', () => {
  const prisma = new PrismaClient();

  const patient = randomUUID();
  const professional = randomUUID();
  const outsider = randomUUID();
  let conversationId: string;

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
    await prisma.$executeRawUnsafe(
      'grant usage on schema public to authenticated',
    );
    await prisma.$executeRawUnsafe(
      'grant usage on schema auth to authenticated',
    );

    await applyMigration(prisma, MIGRATION);

    for (const [id, role] of [
      [patient, 'PACIENTE'],
      [outsider, 'PACIENTE'],
      [professional, 'PROFESIONAL'],
    ] as const) {
      await prisma.profile.create({
        data: { id, email: `chat-${id}@test.local`, role },
      });
    }
    for (const id of [patient, outsider]) {
      await prisma.patient.create({
        data: { profile_id: id, first_name: 'Test', last_name: 'Chat' },
      });
    }
    await prisma.professional.create({
      data: {
        profile_id: professional,
        first_name: 'Test',
        last_name: 'Chat',
        license_number: `MP-${professional.slice(0, 8)}`,
      },
    });

    const conversation = await prisma.conversation.create({
      data: { patient_id: patient, professional_id: professional },
    });
    conversationId = conversation.id;
    await prisma.message.createMany({
      data: [
        {
          conversation_id: conversationId,
          sender_id: patient,
          content: 'Hola',
        },
        {
          conversation_id: conversationId,
          sender_id: professional,
          content: 'Hola, ¿cómo seguís?',
        },
      ],
    });
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
      'drop policy if exists messages_select_participants on public.messages',
      'drop policy if exists conversations_select_participants on public.conversations',
      'alter table public.messages disable row level security',
      'alter table public.conversations disable row level security',
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    await prisma.$disconnect();
  });

  /**
   * Corre `work` como el usuario autenticado: rol `authenticated` y claim `sub`
   * con `SET LOCAL`, el patrón del spike ENG-37.
   */
  function asUser<T>(userId: string, work: (tx: PrismaClient) => Promise<T>) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('set local role authenticated');
      await tx.$executeRawUnsafe(
        `select set_config('request.jwt.claims', '{"sub":"${userId}"}', true)`,
      );
      return work(tx as unknown as PrismaClient);
    });
  }

  const countMessages = (tx: PrismaClient) =>
    tx.$queryRaw<{ n: bigint }[]>`
      select count(*) as n from messages
       where conversation_id = ${conversationId}::uuid`;

  const countConversations = (tx: PrismaClient) =>
    tx.$queryRaw<{ n: bigint }[]>`
      select count(*) as n from conversations
       where id = ${conversationId}::uuid`;

  it.each([
    ['el paciente', () => patient],
    ['el profesional', () => professional],
  ])('%s ve la conversación y sus mensajes', async (_, who) => {
    const [[{ n: messages }], [{ n: conversations }]] = await asUser(
      who(),
      async (tx) => [await countMessages(tx), await countConversations(tx)],
    );

    expect(Number(messages)).toBe(2);
    expect(Number(conversations)).toBe(1);
  });

  it('otra persona no ve nada, aunque pida la conversación por id', async () => {
    const [[{ n: messages }], [{ n: conversations }]] = await asUser(
      outsider,
      async (tx) => [await countMessages(tx), await countConversations(tx)],
    );

    expect(Number(messages)).toBe(0);
    expect(Number(conversations)).toBe(0);
  });

  it('sin filtro, escuchando la tabla entera, tampoco ve mensajes ajenos', async () => {
    const [{ n }] = await asUser(
      outsider,
      (tx) => tx.$queryRaw<{ n: bigint }[]>`select count(*) as n from messages`,
    );

    expect(Number(n)).toBe(0);
  });

  it('el cliente no puede escribir: mandar un mensaje pasa por el backend', async () => {
    await expect(
      asUser(
        patient,
        (tx) => tx.$executeRaw`
          insert into messages (conversation_id, sender_id, content)
          values (${conversationId}::uuid, ${patient}::uuid, 'directo')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('el cliente no puede marcar leído por su cuenta', async () => {
    await expect(
      asUser(
        patient,
        (tx) => tx.$executeRaw`
          update messages set read_at = now()
           where conversation_id = ${conversationId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('la migración se puede volver a correr sin romper nada', async () => {
    await expect(applyMigration(prisma, MIGRATION)).resolves.toBeUndefined();
  });
});
