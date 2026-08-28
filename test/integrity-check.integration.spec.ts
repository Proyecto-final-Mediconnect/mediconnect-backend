/**
 * ENG-85 — Tests de integración del job de verificación contra Postgres real.
 *
 * Lo que no se puede probar con Prisma mockeado:
 *
 *   - Que el `created_at` sobreviva el viaje Node → Postgres → Node sin perder
 *     precisión. Es el hallazgo bloqueante del spike ENG-45 y el que más caro
 *     sale si vuelve: entradas intactas reportadas como manipuladas. En memoria
 *     nunca aparece, porque el `Date` no pasa por la base.
 *   - Que las manipulaciones hechas por SQL directo —el atacante con acceso a la
 *     base, no al backend— se detecten.
 *   - Que el snapshot de cabeza sobreviva entre corridas y convierta el truncado
 *     de cola en detectable.
 *
 * Corre con `pnpm run test:integration`. Todos los datos son sintéticos.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma';
import {
  appendEntry,
  GENESIS_HASH,
  type ChainEntry,
  type ChainEntryInput,
} from '../src/common/hash-chain/hash-chain';
import { IntegrityService } from '../src/integrity/integrity.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { IntegrityAlerter } from '../src/integrity/integrity-alerter';
import type { IntegrityRunResult } from '../src/integrity/integrity.types';

const prisma = new PrismaClient();

/** Alertador de prueba: registra en memoria en vez de hablar con Slack. */
class RecordingAlerter implements IntegrityAlerter {
  readonly alerts: IntegrityRunResult[] = [];
  readonly failures: unknown[] = [];

  inconsistencyDetected(result: IntegrityRunResult): Promise<boolean> {
    this.alerts.push(result);
    return Promise.resolve(true);
  }

  runFailed(error: unknown): Promise<boolean> {
    this.failures.push(error);
    return Promise.resolve(true);
  }
}

let alerter: RecordingAlerter;
let service: IntegrityService;

/** Profesional que firma todos los asientos de los tests. */
const PROFESSIONAL_ID = randomUUID();

/** Pacientes creados por el test, para limpiarlos al final. */
const createdPatients: string[] = [];

function entryInput(
  patientId: string,
  sequenceNumber: number,
  value = 70,
): ChainEntryInput {
  return {
    patientId,
    professionalId: PROFESSIONAL_ID,
    sequenceNumber,
    entryType: 'CONSULTA',
    fhirResourceType: 'Observation',
    content: {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
      valueQuantity: { value, unit: '/min' },
    },
    // Lo genera la aplicación, no `default now()`: para sellar hay que tener el
    // timestamp exacto en memoria al calcular el hash.
    createdAt: new Date(
      Date.UTC(2026, 7, 13, 12, 0, 0) + sequenceNumber * 1000,
    ),
  };
}

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

async function insertEntry(entry: ChainEntry): Promise<void> {
  await prisma.clinicalRecordEntry.create({
    data: {
      patient_id: entry.patientId,
      professional_id: entry.professionalId,
      sequence_number: entry.sequenceNumber,
      entry_type: 'CONSULTA',
      fhir_resource_type: entry.fhirResourceType,
      content: entry.content as object,
      content_hash: entry.contentHash,
      previous_hash: entry.previousHash,
      created_at: entry.createdAt,
    },
  });
}

/** Crea un paciente con `n` entradas selladas y las inserta. */
async function seedChain(
  n: number,
): Promise<{ patientId: string; entries: ChainEntry[] }> {
  const patientId = await createPatient();
  const entries: ChainEntry[] = [];
  let previousHash = GENESIS_HASH;

  for (let i = 1; i <= n; i++) {
    const entry = appendEntry(entryInput(patientId, i, 60 + i), previousHash);
    await insertEntry(entry);
    entries.push(entry);
    previousHash = entry.contentHash;
  }

  return { patientId, entries };
}

/** Fallas de la última corrida que corresponden a un paciente. */
function failuresFor(result: IntegrityRunResult, patientId: string) {
  return result.failures.filter((f) => f.patientId === patientId);
}

describe('Job de verificación de integridad (integration)', () => {
  beforeAll(async () => {
    await prisma.profile.create({
      data: {
        id: PROFESSIONAL_ID,
        email: `pro-${PROFESSIONAL_ID}@test.local`,
        role: 'PROFESIONAL',
      },
    });
    await prisma.professional.create({
      data: {
        profile_id: PROFESSIONAL_ID,
        first_name: 'Test',
        last_name: 'Profesional',
        license_number: 'MN-00000',
      },
    });
  }, 60_000);

  beforeEach(() => {
    alerter = new RecordingAlerter();
    service = new IntegrityService(prisma as unknown as PrismaService, alerter);
  });

  afterEach(async () => {
    // Cada test parte de una base sin HC: el job verifica TODOS los pacientes,
    // así que una cadena rota que quedara de un test anterior contaminaría al
    // siguiente.
    await prisma.chainHeadSnapshot.deleteMany();
    await prisma.clinicalRecordEntry.deleteMany();
    await prisma.integrityCheck.deleteMany();
    if (createdPatients.length > 0) {
      await prisma.patient.deleteMany({
        where: { profile_id: { in: createdPatients } },
      });
      await prisma.profile.deleteMany({
        where: { id: { in: createdPatients } },
      });
      createdPatients.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.professional.deleteMany({
      where: { profile_id: PROFESSIONAL_ID },
    });
    await prisma.profile.deleteMany({ where: { id: PROFESSIONAL_ID } });
    await prisma.$disconnect();
  });

  describe('precisión del timestamp (hallazgo bloqueante de ENG-45)', () => {
    it('el created_at sobrevive el round-trip Node → Postgres → Node', async () => {
      const { patientId, entries } = await seedChain(3);

      const stored = await prisma.clinicalRecordEntry.findMany({
        where: { patient_id: patientId },
        orderBy: { sequence_number: 'asc' },
        select: { created_at: true },
      });

      // Con `timestamptz(6)` esto pasaba igual para timestamps redondos y
      // fallaba con los que trae `default now()`; la aserción que importa es la
      // de abajo, que verifica la cadena leída de disco.
      stored.forEach((row, i) => {
        expect(row.created_at.getTime()).toBe(entries[i].createdAt.getTime());
      });

      const result = await service.run();
      expect(failuresFor(result, patientId)).toEqual([]);
    });

    it('una entrada con milisegundos distintos de cero verifica leída de la base', async () => {
      const patientId = await createPatient();
      // 123 ms: el caso que rompía con microsegundos.
      const createdAt = new Date(Date.UTC(2026, 7, 13, 12, 0, 0, 123));
      const entry = appendEntry(
        { ...entryInput(patientId, 1), createdAt },
        GENESIS_HASH,
      );
      await insertEntry(entry);

      const result = await service.run();

      expect(failuresFor(result, patientId)).toEqual([]);
      expect(result.status).toBe('OK');
    });
  });

  describe('corrida sana', () => {
    it('registra la corrida en integrity_checks y sella la cabeza de cada cadena', async () => {
      const a = await seedChain(4);
      const b = await seedChain(2);

      const result = await service.run();

      expect(result).toMatchObject({
        status: 'OK',
        patientsChecked: 2,
        entriesChecked: 6,
      });
      expect(alerter.alerts).toEqual([]);

      const check = await prisma.integrityCheck.findUniqueOrThrow({
        where: { id: result.checkId },
      });
      expect(check.status).toBe('OK');
      expect(check.inconsistencies_found).toBe(0);

      const snapshotA = await prisma.chainHeadSnapshot.findUniqueOrThrow({
        where: { patient_id: a.patientId },
      });
      expect(snapshotA.head_hash).toBe(a.entries[3].contentHash);
      expect(snapshotA.sequence_number).toBe(4n);

      const snapshotB = await prisma.chainHeadSnapshot.findUniqueOrThrow({
        where: { patient_id: b.patientId },
      });
      expect(snapshotB.sequence_number).toBe(2n);
    });

    it('es idempotente: dos corridas seguidas sin cambios dan las dos OK', async () => {
      await seedChain(3);

      expect((await service.run()).status).toBe('OK');
      expect((await service.run()).status).toBe('OK');
      expect(await prisma.integrityCheck.count()).toBe(2);
    });
  });

  describe('manipulación por SQL directo', () => {
    it('detecta CONTENT_TAMPERED cuando se reescribe el contenido de una entrada', async () => {
      const { patientId } = await seedChain(5);

      // El atacante con acceso a la base cambia el diagnóstico y no toca el
      // hash: no le alcanza el backend, entra por SQL.
      await prisma.$executeRaw`
        update clinical_record_entries
           set content = '{"resourceType":"Observation","status":"final","valueQuantity":{"value":999,"unit":"/min"}}'::jsonb
         where patient_id = ${patientId}::uuid and sequence_number = 3`;

      const result = await service.run();

      expect(result.status).toBe('INCONSISTENT');
      expect(failuresFor(result, patientId)).toEqual([
        expect.objectContaining({
          sequenceNumber: 3,
          reason: 'CONTENT_TAMPERED',
        }),
      ]);
      expect(alerter.alerts).toHaveLength(1);
    });

    it('detecta CONTENT_TAMPERED cuando se reasigna el profesional firmante', async () => {
      const { patientId } = await seedChain(3);
      const otroProfesional = randomUUID();
      await prisma.profile.create({
        data: {
          id: otroProfesional,
          email: `pro2-${otroProfesional}@test.local`,
          role: 'PROFESIONAL',
        },
      });
      await prisma.professional.create({
        data: {
          profile_id: otroProfesional,
          first_name: 'Otro',
          last_name: 'Profesional',
          license_number: 'MN-99999',
        },
      });

      // Cambiar quién firmó es más barato que falsificar el diagnóstico. Por eso
      // `professional_id` entra a la preimagen (Ley 26.529 art. 15).
      await prisma.$executeRaw`
        update clinical_record_entries
           set professional_id = ${otroProfesional}::uuid
         where patient_id = ${patientId}::uuid and sequence_number = 2`;

      const result = await service.run();

      expect(failuresFor(result, patientId)).toEqual([
        expect.objectContaining({
          sequenceNumber: 2,
          reason: 'CONTENT_TAMPERED',
        }),
      ]);

      await prisma.clinicalRecordEntry.deleteMany({
        where: { patient_id: patientId },
      });
      await prisma.professional.deleteMany({
        where: { profile_id: otroProfesional },
      });
      await prisma.profile.deleteMany({ where: { id: otroProfesional } });
    });

    it('detecta BROKEN_LINK cuando se borra una entrada del medio', async () => {
      const { patientId } = await seedChain(5);

      await prisma.$executeRaw`
        delete from clinical_record_entries
         where patient_id = ${patientId}::uuid and sequence_number = 3`;

      const result = await service.run();

      expect(failuresFor(result, patientId)).toEqual([
        expect.objectContaining({ sequenceNumber: 4, reason: 'BROKEN_LINK' }),
      ]);
    });

    it('NO pisa el snapshot de una cadena manipulada', async () => {
      const { patientId, entries } = await seedChain(4);
      await service.run(); // corrida sana: deja la cabeza sellada

      await prisma.$executeRaw`
        update clinical_record_entries
           set content = '{"resourceType":"Observation","tampered":true}'::jsonb
         where patient_id = ${patientId}::uuid and sequence_number = 2`;

      await service.run();

      // Si el job actualizara la cabeza acá, la corrida siguiente tomaría la
      // versión manipulada como línea de base y la manipulación quedaría
      // blanqueada.
      const snapshot = await prisma.chainHeadSnapshot.findUniqueOrThrow({
        where: { patient_id: patientId },
      });
      expect(snapshot.head_hash).toBe(entries[3].contentHash);
      expect(snapshot.sequence_number).toBe(4n);
    });
  });

  describe('lo que solo se detecta contra la corrida anterior', () => {
    it('detecta el truncado de la cola entre dos corridas', async () => {
      const { patientId } = await seedChain(6);
      const primera = await service.run();
      expect(primera.status).toBe('OK');

      // Borrar las 2 últimas deja una cadena que sigue siendo internamente
      // perfecta. Sin el snapshot, esto pasaba por sano.
      await prisma.$executeRaw`
        delete from clinical_record_entries
         where patient_id = ${patientId}::uuid and sequence_number > 4`;

      const segunda = await service.run();

      expect(failuresFor(segunda, patientId)).toEqual([
        expect.objectContaining({
          sequenceNumber: 4,
          reason: 'TAIL_TRUNCATED',
          expected: 'sequence_number >= 6',
        }),
      ]);
    });

    it('detecta el borrado completo de la HC de un paciente', async () => {
      const { patientId } = await seedChain(3);
      await service.run();

      await prisma.$executeRaw`
        delete from clinical_record_entries where patient_id = ${patientId}::uuid`;

      const result = await service.run();

      // Sin filas en clinical_record_entries, el paciente solo aparece porque
      // quedó su snapshot.
      expect(failuresFor(result, patientId)).toEqual([
        expect.objectContaining({
          sequenceNumber: 0,
          reason: 'TAIL_TRUNCATED',
        }),
      ]);
    });

    it('detecta la reescritura completa de la cadena hacia adelante', async () => {
      const { patientId } = await seedChain(5);
      await service.run();

      // El ataque que la cadena sola no puede ver: se cambia una entrada vieja y
      // se recalculan TODOS los hashes posteriores, dejando una cadena nueva y
      // perfectamente coherente consigo misma.
      await prisma.$executeRaw`
        delete from clinical_record_entries where patient_id = ${patientId}::uuid`;
      let previousHash = GENESIS_HASH;
      for (let i = 1; i <= 5; i++) {
        const entry = appendEntry(
          entryInput(patientId, i, i === 2 ? 999 : 60 + i),
          previousHash,
        );
        await insertEntry(entry);
        previousHash = entry.contentHash;
      }

      const result = await service.run();

      expect(failuresFor(result, patientId)).toEqual([
        expect.objectContaining({
          sequenceNumber: 5,
          reason: 'HISTORY_REWRITTEN',
        }),
      ]);
    });

    it('no da falso positivo cuando la cadena simplemente creció', async () => {
      const { patientId, entries } = await seedChain(3);
      await service.run();

      let previousHash = entries[2].contentHash;
      for (let i = 4; i <= 6; i++) {
        const entry = appendEntry(
          entryInput(patientId, i, 60 + i),
          previousHash,
        );
        await insertEntry(entry);
        previousHash = entry.contentHash;
      }

      const result = await service.run();

      expect(result.status).toBe('OK');
      const snapshot = await prisma.chainHeadSnapshot.findUniqueOrThrow({
        where: { patient_id: patientId },
      });
      expect(snapshot.sequence_number).toBe(6n);
    });
  });

  describe('costo', () => {
    it('verifica 1.000 entradas leídas de la base en menos de 1 segundo', async () => {
      const patientId = await createPatient();
      const rows: ChainEntry[] = [];
      let previousHash = GENESIS_HASH;
      for (let i = 1; i <= 1000; i++) {
        const entry = appendEntry(
          entryInput(patientId, i, 60 + (i % 40)),
          previousHash,
        );
        rows.push(entry);
        previousHash = entry.contentHash;
      }
      await prisma.clinicalRecordEntry.createMany({
        data: rows.map((entry) => ({
          patient_id: entry.patientId,
          professional_id: entry.professionalId,
          sequence_number: entry.sequenceNumber,
          entry_type: 'CONSULTA' as const,
          fhir_resource_type: entry.fhirResourceType,
          content: entry.content as object,
          content_hash: entry.contentHash,
          previous_hash: entry.previousHash,
          created_at: entry.createdAt,
        })),
      });

      const result = await service.run();

      // Criterio de aceptación heredado del spike ENG-45, que midió ~42 ms de
      // punta a punta. El margen es enorme a propósito: acá se mide dentro de
      // un runner compartido de CI, no en una notebook.
      expect(result.status).toBe('OK');
      expect(result.entriesChecked).toBe(1000);
      expect(result.durationMs).toBeLessThan(1000);
    }, 120_000);
  });
});
