import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * Tarjeta de emergencia del MediPass (ENG-176), contra Postgres de verdad.
 *
 * El CI prepara la base con `prisma db push`, que deriva el esquema del
 * `schema.prisma` y **no** ejecuta los archivos de migración (ver el spec de
 * ENG-170). Las dos garantías que importan de esta migración viven solo en su
 * SQL, porque Prisma no las modela:
 *
 * - el índice único parcial que deja **una sola tarjeta activa** por paciente,
 *   que es lo que impide que dos regeneraciones simultáneas dejen dos QR
 *   válidos;
 * - el CHECK que obliga a que una sesión entre por el código **o** por la
 *   tarjeta, nunca por los dos ni por ninguno.
 *
 * Así que el spec toma esas sentencias del archivo de migración y las aplica
 * acá, para probar el SQL que va a correr en producción y no una copia.
 */

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261104120000_eng176_medipass_emergency_card',
  'migration.sql',
);

/** Las sentencias de la migración que `db push` no aplica. */
function migrationOnlyStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split(/^--;;[ \t]*\r?$/m)
    .map((s) => s.trim())
    .filter((s) =>
      /one_active_per_patient|origin_check|token_hash_check/.test(s),
    );
}

const hash = (n: number) => n.toString(16).padStart(64, '0');

describe('Tarjeta de emergencia del MediPass (integration)', () => {
  const prisma = new PrismaClient();
  const PATIENT = randomUUID();
  let codeId: string;

  beforeAll(async () => {
    // Si ya estaban (otra corrida en la misma base), se recrean desde el SQL.
    await prisma.$executeRawUnsafe(
      `drop index if exists public."medipass_emergency_cards_one_active_per_patient"`,
    );
    await prisma.$executeRawUnsafe(
      `alter table public.medipass_sessions drop constraint if exists "medipass_sessions_origin_check"`,
    );
    await prisma.$executeRawUnsafe(
      `alter table public.medipass_emergency_cards drop constraint if exists "medipass_emergency_cards_token_hash_check"`,
    );
    const statements = migrationOnlyStatements();
    expect(statements).toHaveLength(3);
    for (const sql of statements) await prisma.$executeRawUnsafe(sql);

    await prisma.profile.create({
      data: {
        id: PATIENT,
        email: `paciente-${PATIENT}@test.local`,
        role: 'PACIENTE',
      },
    });
    await prisma.patient.create({
      data: { profile_id: PATIENT, first_name: 'Test', last_name: 'Tarjeta' },
    });
    const code = await prisma.mediPassCode.create({
      data: {
        patient_id: PATIENT,
        code:
          'TJ' +
          randomUUID()
            .replace(/[^2-9]/g, '')
            .slice(0, 6)
            .padEnd(6, '2'),
        expires_at: new Date(Date.now() + 5 * 60_000),
      },
    });
    codeId = code.id;
  });

  afterEach(async () => {
    await prisma.mediPassSession.deleteMany({ where: { patient_id: PATIENT } });
    await prisma.mediPassEmergencyCard.deleteMany({
      where: { patient_id: PATIENT },
    });
  });

  afterAll(async () => {
    await prisma.mediPassCode.deleteMany({ where: { patient_id: PATIENT } });
    await prisma.patient.delete({ where: { profile_id: PATIENT } });
    await prisma.profile.delete({ where: { id: PATIENT } });
    await prisma.$disconnect();
  });

  it('no deja dos tarjetas activas para el mismo paciente', async () => {
    await prisma.mediPassEmergencyCard.create({
      data: { patient_id: PATIENT, token_hash: hash(1) },
    });

    await expect(
      prisma.mediPassEmergencyCard.create({
        data: { patient_id: PATIENT, token_hash: hash(2) },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('una revocada no cuenta: se puede generar otra', async () => {
    await prisma.mediPassEmergencyCard.create({
      data: {
        patient_id: PATIENT,
        token_hash: hash(3),
        revoked_at: new Date(),
      },
    });

    await expect(
      prisma.mediPassEmergencyCard.create({
        data: { patient_id: PATIENT, token_hash: hash(4) },
      }),
    ).resolves.toBeDefined();
  });

  it('el hash guardado tiene que ser un SHA-256 en hex, nunca el token', async () => {
    await expect(
      prisma.mediPassEmergencyCard.create({
        data: { patient_id: PATIENT, token_hash: 'Z'.repeat(64) },
      }),
    ).rejects.toThrow(/token_hash_check/);
  });

  it('una sesión entra por la tarjeta sin código', async () => {
    const card = await prisma.mediPassEmergencyCard.create({
      data: { patient_id: PATIENT, token_hash: hash(5) },
    });

    await expect(
      prisma.mediPassSession.create({
        data: {
          patient_id: PATIENT,
          emergency_card_id: card.id,
          consultant_name: 'Dr. Integration',
          expires_at: new Date(Date.now() + 30 * 60_000),
        },
      }),
    ).resolves.toBeDefined();
  });

  it('una sesión con código y tarjeta a la vez se rechaza', async () => {
    const card = await prisma.mediPassEmergencyCard.create({
      data: { patient_id: PATIENT, token_hash: hash(6) },
    });

    await expect(
      prisma.mediPassSession.create({
        data: {
          patient_id: PATIENT,
          medipass_code_id: codeId,
          emergency_card_id: card.id,
          consultant_name: 'Dr. Integration',
          expires_at: new Date(Date.now() + 30 * 60_000),
        },
      }),
    ).rejects.toThrow(/origin_check/);
  });

  it('una sesión sin código ni tarjeta se rechaza', async () => {
    await expect(
      prisma.mediPassSession.create({
        data: {
          patient_id: PATIENT,
          consultant_name: 'Dr. Integration',
          expires_at: new Date(Date.now() + 30 * 60_000),
        },
      }),
    ).rejects.toThrow(/origin_check/);
  });
});
