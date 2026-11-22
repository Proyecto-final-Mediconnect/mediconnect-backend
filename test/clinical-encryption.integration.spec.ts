import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SupabaseService } from '../src/supabase/supabase.service';
import { ClinicalRecordsService } from '../src/clinical-records/clinical-records.service';
import { ClinicalDataCipher } from '../src/common/crypto/clinical-data-cipher';
import {
  MissingKeyError,
  parseKeyring,
} from '../src/common/crypto/data-encryption';
import { IntegrityService } from '../src/integrity/integrity.service';
import type { IntegrityAlerter } from '../src/integrity/integrity-alerter';
import { DataExportService } from '../src/privacy/data-export.service';

/**
 * ENG-216 — El cifrado de la HC contra Postgres real.
 *
 * Lo que solo se puede probar acá: que lo que queda en la base esté cifrado de
 * verdad, que la cadena de hash siga verificando (el hash es del contenido en
 * claro), que convivan las entradas viejas en claro con las nuevas cifradas, y
 * que el job de integridad detecte un contenido cifrado copiado a otra fila.
 *
 * Todos los datos son sintéticos.
 */

const prisma = new PrismaClient();
const db = prisma as unknown as PrismaService;
const PROFESSIONAL = '88888888-8888-4888-8888-888888888888';
const createdPatients: string[] = [];

const keyring = parseKeyring(`k1:${randomBytes(32).toString('base64')}`);
const encrypted = new ClinicalDataCipher(db, keyring);
const plain = new ClinicalDataCipher(db, null);

const noPostgrest = {
  getClientForToken: () => {
    throw new Error('este spec no usa PostgREST');
  },
} as unknown as SupabaseService;

const silentAlerter: IntegrityAlerter = {
  inconsistencyDetected: () => Promise.resolve(true),
  runFailed: () => Promise.resolve(true),
  anchorPublished: () => Promise.resolve(true),
};

const records = (cipher: ClinicalDataCipher) =>
  new ClinicalRecordsService(db, noPostgrest, cipher);

async function createPatient(): Promise<string> {
  const id = randomUUID();
  await prisma.profile.create({
    data: { id, email: `cifrado-${id}@test.local`, role: 'PACIENTE' },
  });
  await prisma.patient.create({
    data: { profile_id: id, first_name: 'Test', last_name: 'Cifrado' },
  });
  createdPatients.push(id);
  return id;
}

function entry(patientId: string, summary: string) {
  return {
    patientId,
    professionalId: PROFESSIONAL,
    entryType: 'CONSULTA' as const,
    fhirResourceType: 'ClinicalImpression',
    content: {
      resourceType: 'ClinicalImpression',
      status: 'completed',
      summary,
      note: [{ text: 'No es alérgica a la penicilina.' }],
    },
  };
}

async function rawEntries(patientId: string) {
  return prisma.clinicalRecordEntry.findMany({
    where: { patient_id: patientId },
    orderBy: { sequence_number: 'asc' },
    select: { id: true, content: true, sequence_number: true },
  });
}

describe('Cifrado del contenido de la HC (integration)', () => {
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
        last_name: 'Cifrado',
        license_number: 'MP-CIFRADO',
      },
    });
  }, 60_000);

  afterEach(async () => {
    if (createdPatients.length === 0) return;
    const ids = { in: [...createdPatients] };
    await prisma.chainHeadSnapshot.deleteMany({ where: { patient_id: ids } });
    await prisma.clinicalRecordEntry.deleteMany({ where: { patient_id: ids } });
    await prisma.patientDataKey.deleteMany({ where: { patient_id: ids } });
    await prisma.patient.deleteMany({ where: { profile_id: ids } });
    await prisma.profile.deleteMany({ where: { id: ids } });
    createdPatients.length = 0;
  });

  afterAll(async () => {
    await prisma.integrityCheck.deleteMany();
    await prisma.professional.deleteMany({
      where: { profile_id: PROFESSIONAL },
    });
    await prisma.profile.deleteMany({ where: { id: PROFESSIONAL } });
    await prisma.$disconnect();
  });

  it('lo que queda en la base está cifrado y la API lo devuelve en claro', async () => {
    const patientId = await createPatient();

    const view = await records(encrypted).append(
      entry(patientId, 'Enalapril 10 mg cada 12 horas'),
    );
    expect(view.content).toMatchObject({
      summary: 'Enalapril 10 mg cada 12 horas',
    });

    const [row] = await rawEntries(patientId);
    expect(row.id).toBe(view.id);
    expect(Object.keys(row.content as object)).toEqual(['$enc']);
    expect(JSON.stringify(row.content)).not.toMatch(/Enalapril|penicilina/);

    const key = await prisma.patientDataKey.findUniqueOrThrow({
      where: { patient_id: patientId },
    });
    expect(key.kid).toBe('k1');
    expect(key.wrapped_dek).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('la cadena verifica con entradas viejas en claro y nuevas cifradas mezcladas', async () => {
    const patientId = await createPatient();

    // Antes de prender el cifrado: en claro, como hoy en producción.
    await records(plain).append(entry(patientId, 'Primera consulta'));
    await records(encrypted).append(entry(patientId, 'Segunda consulta'));
    await records(encrypted).append(entry(patientId, 'Tercera consulta'));

    const rows = await rawEntries(patientId);
    expect((rows[0].content as { summary?: string }).summary).toBe(
      'Primera consulta',
    );
    expect(Object.keys(rows[1].content as object)).toEqual(['$enc']);

    const verification = await records(encrypted).verifyPatientChain(patientId);
    expect(verification).toMatchObject({ valid: true, entries: 3 });

    const result = await new IntegrityService(
      db,
      silentAlerter,
      encrypted,
    ).run();
    expect(result.failures.filter((f) => f.patientId === patientId)).toEqual(
      [],
    );
  });

  it('un contenido cifrado copiado a otra fila se detecta como alterado', async () => {
    const patientId = await createPatient();
    await records(encrypted).append(
      entry(patientId, 'Hipertensión controlada'),
    );
    await records(encrypted).append(entry(patientId, 'Sin cambios'));
    const [first, second] = await rawEntries(patientId);

    // Pegar el contenido de la segunda en la primera: los dos son cifrados
    // válidos del mismo paciente, pero el AAD ata cada uno a su fila.
    await prisma.$executeRaw`
      update clinical_record_entries set content = ${JSON.stringify(second.content)}::jsonb
      where id = ${first.id}::uuid`;

    const verification = await records(encrypted).verifyPatientChain(patientId);
    expect(verification).toMatchObject({
      valid: false,
      failure: { sequenceNumber: 1, reason: 'CONTENT_TAMPERED' },
    });

    const result = await new IntegrityService(
      db,
      silentAlerter,
      encrypted,
    ).run();
    const failures = result.failures.filter((f) => f.patientId === patientId);
    expect(failures).toEqual([
      expect.objectContaining({
        sequenceNumber: 1,
        reason: 'CONTENT_TAMPERED',
        found: 'contenido cifrado ilegible',
      }),
    ]);
    // Nada del contenido en lo que va a integrity_checks y a Slack.
    expect(JSON.stringify(failures)).not.toMatch(/Hipertensión|Sin cambios/);
  });

  it('sin la clave, el job no da OK: termina en error', async () => {
    const patientId = await createPatient();
    await records(encrypted).append(entry(patientId, 'Control'));

    await expect(
      new IntegrityService(db, silentAlerter, plain).run(),
    ).rejects.toThrow(MissingKeyError);
  });

  it('la exportación de datos del paciente entrega su HC en claro', async () => {
    const patientId = await createPatient();
    await records(encrypted).append(entry(patientId, 'Consulta exportable'));

    const exported = (await new DataExportService(db, encrypted).export(
      patientId,
    )) as unknown as {
      paciente: { historiaClinica: { contenido: { summary: string } }[] };
    };
    const json = JSON.stringify(exported);
    expect(json).toContain('Consulta exportable');
    expect(json).not.toContain('$enc');
  });
});
