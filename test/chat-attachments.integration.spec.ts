import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * El `CHECK` de los adjuntos del chat (ENG-102), contra Postgres real.
 *
 * Carga la migración statement por statement, como los specs de ENG-57 y
 * ENG-145: el CI de integración prepara la base con `prisma db push`, que crea
 * las columnas pero **no** el `CHECK`, así que sin esto la restricción correría
 * por primera vez en el deploy. El bloque del bucket se saltea solo: el
 * Postgres de tests no tiene el schema `storage`.
 */

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261104160000_eng102_chat_attachments',
  'migration.sql',
);

async function applyMigration(prisma: PrismaClient): Promise<void> {
  for (const statement of readFileSync(MIGRATION, 'utf8').split(
    /^--;;[ \t]*\r?$/m,
  )) {
    const sql = statement.trim();
    if (sql.length > 0) await prisma.$executeRawUnsafe(sql);
  }
}

describe('Adjuntos del chat: el CHECK de messages (integration)', () => {
  const prisma = new PrismaClient();
  const PATIENT = randomUUID();
  const PRO = randomUUID();
  const CONVERSATION = randomUUID();

  beforeAll(async () => {
    await applyMigration(prisma);
    // Dos veces: la migración es idempotente.
    await applyMigration(prisma);

    await prisma.profile.createMany({
      data: [
        {
          id: PATIENT,
          email: `eng102-pac-${PATIENT}@test.local`,
          role: 'PACIENTE',
        },
        { id: PRO, email: `eng102-pro-${PRO}@test.local`, role: 'PROFESIONAL' },
      ],
    });
    await prisma.patient.create({
      data: { profile_id: PATIENT, first_name: 'Test', last_name: 'Adjuntos' },
    });
    await prisma.professional.create({
      data: {
        profile_id: PRO,
        first_name: 'Pro',
        last_name: 'Adjuntos',
        license_number: `MP-${PRO.slice(0, 8)}`,
        status: 'VALIDADO',
      },
    });
    await prisma.conversation.create({
      data: { id: CONVERSATION, patient_id: PATIENT, professional_id: PRO },
    });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({
      where: { conversation_id: CONVERSATION },
    });
    await prisma.conversation.deleteMany({ where: { id: CONVERSATION } });
    await prisma.professional.deleteMany({ where: { profile_id: PRO } });
    await prisma.patient.deleteMany({ where: { profile_id: PATIENT } });
    await prisma.profile.deleteMany({ where: { id: { in: [PATIENT, PRO] } } });
    await prisma.$disconnect();
  });

  const base = () => ({ conversation_id: CONVERSATION, sender_id: PATIENT });
  const adjunto = {
    attachment_url: `${CONVERSATION}/a.pdf`,
    attachment_mime: 'application/pdf',
    attachment_size: 1024,
  };

  /** El código de Postgres de una violación de `CHECK`. */
  async function violaElCheck(data: Record<string, unknown>): Promise<void> {
    await expect(
      prisma.message.create({ data: { ...base(), ...data } }),
    ).rejects.toThrow(/messages_attachment_check|23514/);
  }

  it('acepta un mensaje de texto, uno con archivo y uno con los dos', async () => {
    await prisma.message.create({ data: { ...base(), content: 'Hola' } });
    await prisma.message.create({ data: { ...base(), ...adjunto } });
    await prisma.message.create({
      data: { ...base(), content: 'El estudio', ...adjunto },
    });
  });

  it('rechaza un mensaje sin texto ni archivo, o con texto en blanco', async () => {
    await violaElCheck({});
    await violaElCheck({ content: '   ' });
  });

  it('rechaza un archivo a medias: ruta sin tipo, o tipo sin tamaño', async () => {
    await violaElCheck({ attachment_url: 'x/a.pdf', content: 'hola' });
    await violaElCheck({
      attachment_url: 'x/a.pdf',
      attachment_mime: 'application/pdf',
      content: 'hola',
    });
  });

  it('rechaza un tipo no aceptado, un archivo vacío y uno de más de 10 MB', async () => {
    await violaElCheck({
      ...adjunto,
      attachment_mime: 'application/x-msdownload',
    });
    await violaElCheck({ ...adjunto, attachment_size: 0 });
    await violaElCheck({ ...adjunto, attachment_size: 10 * 1024 * 1024 + 1 });
  });
});
