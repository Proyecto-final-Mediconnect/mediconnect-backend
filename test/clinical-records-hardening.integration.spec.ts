import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';
import {
  appendEntry,
  GENESIS_HASH,
  type ChainEntry,
  type ChainEntryInput,
} from '../src/common/hash-chain/hash-chain';

/**
 * Endurecimiento del modelo de HC contra Postgres real (ENG-126).
 *
 * Cubre los tres huecos que quedaron de ENG-57. Cada uno solo se puede probar
 * contra una base de verdad: son reglas que viven en triggers, no en el service.
 *
 * Va en un archivo propio y no dentro de `clinical-records.integration.spec.ts`
 * porque ENG-58 (PR backend #44) tiene ese archivo abierto en review, y meterle
 * mano garantizaría un conflicto.
 *
 * Aplica las DOS migraciones en orden —la de ENG-57 crea los triggers, la de
 * ENG-126 los reemplaza y suma el de TRUNCATE— y deshace todo al terminar: los
 * specs de integración comparten base, y el de ENG-85 hace `deleteMany` y
 * `UPDATE` sobre esta tabla para simular manipulación. Con el trigger append-only
 * puesto, esas simulaciones fallarían.
 *
 * Todos los recursos FHIR son sintéticos.
 */

const migrationPath = (name: string) =>
  join(__dirname, '..', 'prisma', 'migrations', name, 'migration.sql');

const ENG57 = migrationPath('20260826120000_eng57_clinical_record_chain');
const ENG126 = migrationPath('20260829000000_eng126_clinical_record_hardening');

const PROFESSIONAL = '33333333-3333-4333-8333-333333333333';

const createdPatients: string[] = [];

/** Carga un archivo de migración statement por statement (separador `--;;`). */
async function applyMigration(prisma: PrismaClient, path: string) {
  for (const statement of readFileSync(path, 'utf8').split(
    /^--;;[ \t]*\r?$/m,
  )) {
    const sql = statement.trim();
    if (sql.length > 0) await prisma.$executeRawUnsafe(sql);
  }
}

describe('Endurecimiento del modelo de HC (integration)', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.profile.create({
      data: {
        id: PROFESSIONAL,
        email: `pro-${PROFESSIONAL}@test.local`,
        role: 'PROFESIONAL',
      },
    });
    await prisma.professional.create({
      data: {
        profile_id: PROFESSIONAL,
        first_name: 'Test',
        last_name: 'Hardening',
        license_number: `MP-${PROFESSIONAL.slice(0, 8)}`,
      },
    });

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

    await applyMigration(prisma, ENG57);
    await applyMigration(prisma, ENG126);
  }, 60_000);

  afterAll(async () => {
    for (const sql of [
      'drop trigger if exists clinical_record_entries_no_truncate on public.clinical_record_entries',
      'drop trigger if exists clinical_record_entries_no_mutation on public.clinical_record_entries',
      'drop trigger if exists clinical_record_entries_link on public.clinical_record_entries',
      'drop policy if exists clinical_record_entries_select_own_patient on public.clinical_record_entries',
      'alter table public.clinical_record_entries no force row level security',
      'alter table public.clinical_record_entries disable row level security',
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }

    await prisma.clinicalRecordEntry.deleteMany({
      where: { patient_id: { in: createdPatients } },
    });
    await prisma.patient.deleteMany({
      where: { profile_id: { in: createdPatients } },
    });
    await prisma.profile.deleteMany({
      where: { id: { in: [...createdPatients, PROFESSIONAL] } },
    });
    await prisma.professional.deleteMany({
      where: { profile_id: PROFESSIONAL },
    });

    await prisma.$disconnect();
  });

  async function createPatient(): Promise<string> {
    const id = randomUUID();
    await prisma.profile.create({
      data: { id, email: `paciente-${id}@test.local`, role: 'PACIENTE' },
    });
    await prisma.patient.create({
      data: { profile_id: id, first_name: 'Test', last_name: 'Paciente' },
    });
    createdPatients.push(id);
    return id;
  }

  function entryInput(
    patientId: string,
    sequenceNumber: number,
    correctsEntryId: string | null = null,
  ): ChainEntryInput {
    return {
      patientId,
      professionalId: PROFESSIONAL,
      sequenceNumber,
      entryType: correctsEntryId ? 'CORRECCION' : 'CONSULTA',
      fhirResourceType: 'Observation',
      content: {
        resourceType: 'Observation',
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
        valueQuantity: { value: 70, unit: '/min' },
      },
      correctsEntryId,
      createdAt: new Date(Date.UTC(2026, 7, 29, 12, 0, sequenceNumber)),
    };
  }

  function insert(entry: ChainEntry) {
    return prisma.$executeRaw`
      insert into clinical_record_entries (
        patient_id, professional_id, sequence_number, entry_type,
        fhir_resource_type, content, consultation_id, corrects_entry_id,
        content_hash, previous_hash, created_at
      ) values (
        ${entry.patientId}::uuid,
        ${entry.professionalId}::uuid,
        ${entry.sequenceNumber}::bigint,
        ${entry.entryType}::entry_type,
        ${entry.fhirResourceType},
        ${JSON.stringify(entry.content)}::jsonb,
        ${entry.consultationId ?? null}::uuid,
        ${entry.correctsEntryId ?? null}::uuid,
        ${entry.contentHash},
        ${entry.previousHash},
        ${entry.createdAt}
      )`;
  }

  /** Primera entrada de una HC nueva, y devuelve su id. */
  async function seedFirstEntry(patientId: string): Promise<string> {
    const sealed = appendEntry(entryInput(patientId, 1), GENESIS_HASH);
    await insert(sealed);
    const [row] = await prisma.$queryRaw<{ id: string }[]>`
      select id from clinical_record_entries
       where patient_id = ${patientId}::uuid and sequence_number = 1`;
    return row.id;
  }

  describe('TRUNCATE', () => {
    it('está bloqueado incluso para el owner', async () => {
      const patient = await createPatient();
      await seedFirstEntry(patient);

      await expect(
        prisma.$executeRawUnsafe(
          'truncate table public.clinical_record_entries cascade',
        ),
      ).rejects.toThrow(/append-only/i);
    });

    it('no borró nada al fallar', async () => {
      const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
        select count(*)::bigint as count from clinical_record_entries`;
      expect(Number(count)).toBeGreaterThan(0);
    });
  });

  describe('corrects_entry_id', () => {
    it('rechaza una corrección que apunta a la HC de otro paciente', async () => {
      const pacienteA = await createPatient();
      const pacienteB = await createPatient();

      const entradaDeA = await seedFirstEntry(pacienteA);
      const primeraDeB = await seedFirstEntry(pacienteB);

      // B intenta "corregir" una entrada que es de la historia de A.
      const cruzada = appendEntry(
        entryInput(pacienteB, 2, entradaDeA),
        (await headHashOf(pacienteB)) ?? GENESIS_HASH,
      );

      await expect(insert(cruzada)).rejects.toThrow(
        /no puede cruzar historias clínicas/i,
      );
      expect(primeraDeB).toBeDefined();
    });

    it('acepta una corrección dentro de la misma HC', async () => {
      const patient = await createPatient();
      const original = await seedFirstEntry(patient);

      const correccion = appendEntry(
        entryInput(patient, 2, original),
        (await headHashOf(patient))!,
      );

      await expect(insert(correccion)).resolves.toBe(1);
    });

    it('sigue aceptando entradas sin corrección (el caso normal)', async () => {
      const patient = await createPatient();
      await seedFirstEntry(patient);

      const siguiente = appendEntry(
        entryInput(patient, 2),
        (await headHashOf(patient))!,
      );

      await expect(insert(siguiente)).resolves.toBe(1);
    });

    it('rechaza una corrección que apunta a una entrada inexistente', async () => {
      const patient = await createPatient();
      await seedFirstEntry(patient);

      const fantasma = appendEntry(
        entryInput(patient, 2, randomUUID()),
        (await headHashOf(patient))!,
      );

      await expect(insert(fantasma)).rejects.toThrow(/no existe/i);
    });
  });

  describe('las funciones de trigger', () => {
    it('son SECURITY DEFINER y tienen search_path fijado', async () => {
      const rows = await prisma.$queryRaw<
        { proname: string; prosecdef: boolean; proconfig: string[] | null }[]
      >`
        select proname, prosecdef, proconfig
          from pg_proc
         where proname in (
           'clinical_record_entries_check_link',
           'clinical_record_entries_block_mutation'
         )`;

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.prosecdef).toBe(true);
        expect(row.proconfig?.join(' ')).toMatch(/search_path=/);
      }
    });
  });

  describe('idempotencia', () => {
    it('la migración se puede aplicar de nuevo sin romper nada', async () => {
      await expect(applyMigration(prisma, ENG126)).resolves.toBeUndefined();

      const patient = await createPatient();
      await seedFirstEntry(patient);

      await expect(
        prisma.$executeRawUnsafe(
          'truncate table public.clinical_record_entries cascade',
        ),
      ).rejects.toThrow(/append-only/i);
    });
  });

  /** Hash de la cabeza actual de la cadena del paciente. */
  async function headHashOf(patientId: string): Promise<string | null> {
    const [row] = await prisma.$queryRaw<{ content_hash: string }[]>`
      select content_hash from clinical_record_entries
       where patient_id = ${patientId}::uuid
       order by sequence_number desc limit 1`;
    return row?.content_hash ?? null;
  }
});
