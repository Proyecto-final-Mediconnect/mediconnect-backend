import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SupabaseService } from '../src/supabase/supabase.service';
import { ClinicalRecordsService } from '../src/clinical-records/clinical-records.service';
import { CORRECTION_REASON_EXTENSION } from '../src/clinical-records/clinical-entry.fhir';

/**
 * Corregir una entrada de HC, contra Postgres real (ENG-100).
 *
 * Los tests unitarios del service cubren las reglas con Prisma mockeado. Lo que
 * solo se puede probar acá es que el camino completo **conviva con los triggers**:
 * que la corrección entre por el mismo INSERT validado que cualquier otra
 * entrada, que la original siga intacta después (no porque el service no la
 * toque, sino porque la base no lo permitiría) y que la cadena verifique con la
 * corrección adentro.
 *
 * Se ejercita el **service**, no HTTP: lo que importa es el sellado y las reglas
 * sobre la tabla. Supabase queda como stub porque el camino de escritura no lo
 * usa — si alguna vez lo usara, el stub tira y el test lo dice.
 *
 * Aplica las migraciones de ENG-57 y ENG-126 y deshace todo al terminar, por el
 * mismo motivo que los otros specs de HC: la base de integración es compartida y
 * el spec de ENG-85 hace `UPDATE`/`deleteMany` sobre esta tabla para simular
 * manipulación, cosa que el trigger append-only rechazaría.
 *
 * Todos los recursos FHIR son sintéticos.
 */

const migrationPath = (name: string) =>
  join(__dirname, '..', 'prisma', 'migrations', name, 'migration.sql');

const ENG57 = migrationPath('20260826120000_eng57_clinical_record_chain');
const ENG126 = migrationPath('20260829210000_eng126_clinical_record_hardening');

const AUTHOR = '66666666-6666-4666-8666-666666666666';
const OTHER_PROFESSIONAL = '77777777-7777-4777-8777-777777777777';
const PROFESSIONALS = [AUTHOR, OTHER_PROFESSIONAL];

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

describe('Corregir una entrada de HC (integration)', () => {
  const prisma = new PrismaClient();
  let service: ClinicalRecordsService;

  beforeAll(async () => {
    for (const id of PROFESSIONALS) {
      await prisma.profile.create({
        data: { id, email: `pro-${id}@test.local`, role: 'PROFESIONAL' },
      });
      await prisma.professional.create({
        data: {
          profile_id: id,
          first_name: 'Test',
          last_name: 'Correcciones',
          license_number: `MP-${id.slice(0, 8)}`,
        },
      });
    }

    // Piezas que en producción trae Supabase y este Postgres no tiene. Van porque
    // la migración de ENG-57 crea una política de RLS que las referencia, no
    // porque el camino de escritura las use.
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

    const supabase = {
      getClientForToken: () => {
        throw new Error(
          'el camino de escritura de la HC no debe usar PostgREST',
        );
      },
    } as unknown as SupabaseService;

    service = new ClinicalRecordsService(
      prisma as unknown as PrismaService,
      supabase,
    );
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
    await prisma.professional.deleteMany({
      where: { profile_id: { in: PROFESSIONALS } },
    });
    await prisma.profile.deleteMany({
      where: { id: { in: [...createdPatients, ...PROFESSIONALS] } },
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

  /**
   * Asiento original, escrito por `AUTHOR`.
   *
   * Va por `append` y no por `addEntryAsProfessional` para no tener que armar un
   * turno: lo que se prueba acá es la corrección, y el gate del alta ya tiene sus
   * propios tests.
   */
  function seedEntry(patientId: string) {
    return service.append({
      patientId,
      professionalId: AUTHOR,
      entryType: 'CONSULTA',
      fhirResourceType: 'ClinicalImpression',
      content: {
        resourceType: 'ClinicalImpression',
        status: 'completed',
        description: 'Control de rutina',
      },
    });
  }

  const form = {
    reason: 'Control de rutina',
    diagnosis: 'Lumbalgia mecánica',
    correctionReason: 'El diagnóstico quedó con el código de otra patología',
  };

  const correct = (patientId: string, entryId: string, by = AUTHOR) =>
    service.correctEntryAsProfessional(by, patientId, entryId, form);

  it('la entrada original queda intacta y la corrección es una fila nueva', async () => {
    const patientId = await createPatient();
    const original = await seedEntry(patientId);

    const correction = await correct(patientId, original.id);

    const rows = await prisma.clinicalRecordEntry.findMany({
      where: { patient_id: patientId },
      orderBy: { sequence_number: 'asc' },
    });

    expect(rows).toHaveLength(2);
    // Byte por byte lo que había: mismo hash, misma secuencia, mismo contenido.
    expect(rows[0].id).toBe(original.id);
    expect(rows[0].content_hash).toBe(original.contentHash);
    expect(rows[0].content).toEqual(original.content);
    expect(rows[0].corrects_entry_id).toBeNull();

    expect(rows[1].id).toBe(correction.id);
    expect(rows[1].entry_type).toBe('CORRECCION');
    expect(rows[1].corrects_entry_id).toBe(original.id);
  });

  it('la cadena sigue íntegra con la corrección adentro', async () => {
    const patientId = await createPatient();
    const original = await seedEntry(patientId);
    await correct(patientId, original.id);

    await expect(service.verifyPatientChain(patientId)).resolves.toMatchObject({
      valid: true,
      entries: 2,
    });
  });

  it('la corrección se encadena contra la entrada que corrige', async () => {
    const patientId = await createPatient();
    const original = await seedEntry(patientId);

    const correction = await correct(patientId, original.id);

    expect(correction.sequenceNumber).toBe(original.sequenceNumber + 1);
    expect(correction.previousHash).toBe(original.contentHash);
  });

  it('el motivo de la corrección queda guardado dentro del content', async () => {
    // Está dentro del `content`, así que entra a la preimagen del hash: nadie
    // puede reescribir después por qué se corrigió.
    const patientId = await createPatient();
    const original = await seedEntry(patientId);

    const correction = await correct(patientId, original.id);

    expect(correction.content).toMatchObject({
      previous: { reference: `ClinicalImpression/${original.id}` },
      extension: [
        {
          url: CORRECTION_REASON_EXTENSION,
          valueString: form.correctionReason,
        },
      ],
    });
  });

  it('se puede corregir una corrección: queda una cadena lineal', async () => {
    const patientId = await createPatient();
    const original = await seedEntry(patientId);
    const primera = await correct(patientId, original.id);

    const segunda = await correct(patientId, primera.id);

    expect(segunda.correctsEntryId).toBe(primera.id);
    await expect(service.verifyPatientChain(patientId)).resolves.toMatchObject({
      valid: true,
      entries: 3,
    });
  });

  it('409 al corregir dos veces la misma entrada', async () => {
    const patientId = await createPatient();
    const original = await seedEntry(patientId);
    await correct(patientId, original.id);

    await expect(correct(patientId, original.id)).rejects.toThrow(
      ConflictException,
    );
  });

  it('dos correcciones simultáneas de la misma entrada: entra una sola', async () => {
    // Las dos pasan el chequeo previo —todavía no hay corrección—, así que lo
    // único que puede frenar a la segunda es la unique de corrects_entry_id.
    const patientId = await createPatient();
    const original = await seedEntry(patientId);

    const results = await Promise.allSettled([
      correct(patientId, original.id),
      correct(patientId, original.id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(rejected.reason).toBeInstanceOf(ConflictException);

    await expect(
      prisma.clinicalRecordEntry.count({
        where: { corrects_entry_id: original.id },
      }),
    ).resolves.toBe(1);
  });

  it('403 si la entrada la firmó otro profesional', async () => {
    const patientId = await createPatient();
    const original = await seedEntry(patientId);

    await expect(
      correct(patientId, original.id, OTHER_PROFESSIONAL),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      prisma.clinicalRecordEntry.count({ where: { patient_id: patientId } }),
    ).resolves.toBe(1);
  });

  it('404 si la entrada es de la HC de otro paciente', async () => {
    // El trigger de ENG-126 también lo rechazaría, pero con un 500: el service
    // corta antes y con el status que corresponde.
    const unPaciente = await createPatient();
    const otroPaciente = await createPatient();
    const original = await seedEntry(unPaciente);

    await expect(correct(otroPaciente, original.id)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('404 si la entrada no existe', async () => {
    const patientId = await createPatient();

    await expect(correct(patientId, randomUUID())).rejects.toThrow(
      NotFoundException,
    );
  });
});
