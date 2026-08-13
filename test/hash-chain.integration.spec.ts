/**
 * ENG-45 — Tests de integración del prototipo de cadena de hash contra Postgres real.
 *
 * Lo que no se puede probar sin base: que la tabla sea append-only de verdad, que
 * el trigger rechace una entrada mal encadenada, y que la verificación de 1.000
 * entradas leídas de disco entre en 1 segundo.
 *
 * Corre con `pnpm run test:integration`. Todos los recursos FHIR son sintéticos.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';
import {
  appendEntry,
  computeContentHash,
  GENESIS_HASH,
  verifyChain,
  type ChainEntry,
  type ChainEntryInput,
} from '../src/common/hash-chain/hash-chain';

const SPIKE_SQL = join(
  __dirname,
  '..',
  'prisma',
  'spikes',
  'eng45_hash_chain.sql',
);

interface ChainRow {
  id: string;
  patient_id: string;
  sequence_number: bigint;
  entry_type: string;
  fhir_resource_type: string;
  content: unknown;
  corrects_entry_id: string | null;
  content_hash: string;
  previous_hash: string;
  created_at: Date;
}

interface VerifyRow {
  ok: boolean;
  entries: bigint;
  first_bad_sequence: bigint | null;
  reason: string | null;
}

describe('Cadena de hash SHA-256 (integration)', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    // `prisma db push` sincroniza schema.prisma pero no ejecuta SQL suelto, así
    // que la tabla del spike se crea acá.
    for (const statement of readFileSync(SPIKE_SQL, 'utf8').split('--;;')) {
      const sql = statement.trim();
      if (sql.length > 0) await prisma.$executeRawUnsafe(sql);
    }
  }, 60_000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'drop table if exists spike_hash_chain_entries cascade',
    );
    await prisma.$disconnect();
  });

  function entryInput(
    patientId: string,
    sequenceNumber: number,
    value = 70,
  ): ChainEntryInput {
    return {
      patientId,
      sequenceNumber,
      entryType: 'CONSULTA',
      fhirResourceType: 'Observation',
      content: {
        resourceType: 'Observation',
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
        valueQuantity: { value, unit: '/min' },
      },
      // Lo genera la aplicación, no la base: si lo pusiera Postgres con
      // `default now()` no tendríamos el valor exacto al calcular el hash.
      createdAt: new Date(
        Date.UTC(2026, 7, 13, 12, 0, 0) + sequenceNumber * 1000,
      ),
    };
  }

  function insert(entry: ChainEntry & { id?: string }) {
    return prisma.$executeRaw`
      insert into spike_hash_chain_entries (
        id, patient_id, sequence_number, entry_type, fhir_resource_type,
        content, corrects_entry_id, content_hash, previous_hash, created_at
      ) values (
        ${entry.id ?? randomUUID()}::uuid,
        ${entry.patientId}::uuid,
        ${entry.sequenceNumber}::bigint,
        ${entry.entryType},
        ${entry.fhirResourceType},
        ${JSON.stringify(entry.content)}::jsonb,
        ${entry.correctsEntryId ?? null}::uuid,
        ${entry.contentHash},
        ${entry.previousHash},
        ${entry.createdAt}
      )`;
  }

  /** Sella e inserta `n` entradas para un paciente nuevo. */
  async function seedChain(
    n: number,
  ): Promise<{ patientId: string; head: string }> {
    const patientId = randomUUID();
    let previousHash = GENESIS_HASH;

    for (let i = 1; i <= n; i++) {
      const entry = appendEntry(
        entryInput(patientId, i, 60 + (i % 40)),
        previousHash,
      );
      await insert(entry);
      previousHash = entry.contentHash;
    }

    return { patientId, head: previousHash };
  }

  async function readChain(patientId: string): Promise<ChainEntry[]> {
    const rows = await prisma.$queryRaw<ChainRow[]>`
      select id, patient_id, sequence_number, entry_type, fhir_resource_type,
             content, corrects_entry_id, content_hash, previous_hash, created_at
        from spike_hash_chain_entries
       where patient_id = ${patientId}::uuid
       order by sequence_number`;

    return rows.map((row) => ({
      patientId: row.patient_id,
      sequenceNumber: Number(row.sequence_number),
      entryType: row.entry_type,
      fhirResourceType: row.fhir_resource_type,
      content: row.content,
      correctsEntryId: row.corrects_entry_id,
      createdAt: row.created_at,
      contentHash: row.content_hash,
      previousHash: row.previous_hash,
    }));
  }

  /**
   * Simula al atacante con privilegios: deshabilita el trigger append-only,
   * corre el UPDATE y lo vuelve a habilitar. Es lo que la cadena tiene que
   * detectar, porque contra este nivel de acceso el trigger no alcanza.
   */
  async function tamper(sql: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      'alter table spike_hash_chain_entries disable trigger spike_hash_chain_no_mutation',
    );
    try {
      await prisma.$executeRawUnsafe(sql);
    } finally {
      await prisma.$executeRawUnsafe(
        'alter table spike_hash_chain_entries enable trigger spike_hash_chain_no_mutation',
      );
    }
  }

  describe('append-only', () => {
    it('rechaza UPDATE sobre una entrada existente', async () => {
      const { patientId } = await seedChain(1);

      await expect(
        prisma.$executeRawUnsafe(
          `update spike_hash_chain_entries set entry_type = 'OTRO' where patient_id = '${patientId}'`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('rechaza DELETE sobre una entrada existente', async () => {
      const { patientId } = await seedChain(1);

      await expect(
        prisma.$executeRawUnsafe(
          `delete from spike_hash_chain_entries where patient_id = '${patientId}'`,
        ),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('enlace verificado en el INSERT', () => {
    it('rechaza una primera entrada que no arranca en el hash génesis', async () => {
      const patientId = randomUUID();
      const entry = appendEntry(entryInput(patientId, 1), 'a'.repeat(64));

      await expect(insert(entry)).rejects.toThrow(/hash génesis/);
    });

    it('rechaza una entrada cuyo previous_hash no es la cabeza de la cadena', async () => {
      const { patientId } = await seedChain(2);
      const entry = appendEntry(entryInput(patientId, 3), 'b'.repeat(64));

      await expect(insert(entry)).rejects.toThrow(/previous_hash no coincide/);
    });

    it('rechaza un sequence_number no contiguo', async () => {
      const { patientId, head } = await seedChain(2);
      const entry = appendEntry(entryInput(patientId, 9), head);

      await expect(insert(entry)).rejects.toThrow(/no contiguo/);
    });
  });

  describe('detección de manipulación', () => {
    it('detecta contenido reescrito por SQL directo', async () => {
      const { patientId } = await seedChain(4);
      await tamper(
        `update spike_hash_chain_entries
            set content = '{"resourceType":"Observation","status":"final","valueQuantity":{"value":999,"unit":"/min"}}'::jsonb
          where patient_id = '${patientId}' and sequence_number = 2`,
      );

      const result = verifyChain(await readChain(patientId));

      expect(result.valid).toBe(false);
      expect(result).toMatchObject({
        failure: { sequenceNumber: 2, reason: 'CONTENT_TAMPERED' },
      });
    });

    it('detecta una entrada borrada del medio, y el chequeo SQL la ve igual', async () => {
      const { patientId } = await seedChain(4);
      await tamper(
        `delete from spike_hash_chain_entries
          where patient_id = '${patientId}' and sequence_number = 2`,
      );

      const result = verifyChain(await readChain(patientId));
      expect(result.valid).toBe(false);
      expect(result).toMatchObject({ failure: { sequenceNumber: 3 } });

      const [sqlCheck] = await prisma.$queryRaw<VerifyRow[]>`
        select * from spike_hash_chain_verify(${patientId}::uuid)`;
      expect(sqlCheck.ok).toBe(false);
      expect(sqlCheck.first_bad_sequence).toBe(3n);
    });

    it('el chequeo SQL da OK en una cadena íntegra', async () => {
      const { patientId } = await seedChain(5);

      const [sqlCheck] = await prisma.$queryRaw<VerifyRow[]>`
        select * from spike_hash_chain_verify(${patientId}::uuid)`;

      expect(sqlCheck).toMatchObject({
        ok: true,
        entries: 5n,
        first_bad_sequence: null,
      });
    });
  });

  describe('flujo de corrección', () => {
    it('registra la corrección como entrada nueva y deja la errónea en la historia', async () => {
      const { patientId, head } = await seedChain(2);
      const [original] = await prisma.$queryRaw<{ id: string }[]>`
        select id from spike_hash_chain_entries
         where patient_id = ${patientId}::uuid and sequence_number = 2`;

      const correction = appendEntry(
        { ...entryInput(patientId, 3, 85), correctsEntryId: original.id },
        head,
      );
      await insert(correction);

      const chain = await readChain(patientId);

      expect(verifyChain(chain).valid).toBe(true);
      expect(chain).toHaveLength(3);
      // La entrada corregida sigue ahí: nada se borra ni se pisa.
      expect(chain[1].correctsEntryId).toBeNull();
      expect(chain[2].correctsEntryId).toBe(original.id);
    });
  });

  describe('performance', () => {
    it('verifica 1.000 entradas leídas de la base en menos de 1 segundo', async () => {
      const { patientId } = await seedChain(1000);

      const startRead = process.hrtime.bigint();
      const chain = await readChain(patientId);
      const startVerify = process.hrtime.bigint();
      const result = verifyChain(chain);
      const end = process.hrtime.bigint();

      const readMs = Number(startVerify - startRead) / 1e6;
      const verifyMs = Number(end - startVerify) / 1e6;
      const totalMs = Number(end - startRead) / 1e6;

      // Queda en la salida de CI: es la métrica que pide el criterio de ENG-45.
      console.log(
        `[ENG-45] 1.000 entradas — lectura ${readMs.toFixed(1)} ms · ` +
          `verificación ${verifyMs.toFixed(1)} ms · total ${totalMs.toFixed(1)} ms`,
      );

      expect(result).toMatchObject({ valid: true, entries: 1000 });
      expect(totalMs).toBeLessThan(1000);
    }, 120_000);
  });

  describe('round-trip de precisión', () => {
    it('el hash recalculado sobre lo leído de la base coincide con el original', async () => {
      const patientId = randomUUID();
      const original = appendEntry(entryInput(patientId, 1), GENESIS_HASH);
      await insert(original);

      const [stored] = await readChain(patientId);

      // Si `created_at` fuese timestamptz(6), acá se perderían los microsegundos
      // y este recálculo fallaría con la entrada intacta.
      expect(computeContentHash(stored, stored.previousHash)).toBe(
        original.contentHash,
      );
      expect(stored.createdAt.getTime()).toBe(original.createdAt.getTime());
    });
  });
});
