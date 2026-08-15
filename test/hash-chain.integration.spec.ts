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
  NON_HASHED_COLUMNS,
  PREIMAGE_COLUMNS,
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

/** Profesional que firma los asientos de los tests. Sintético. */
const PROFESSIONAL_ID = '22222222-2222-4222-8222-222222222222';

interface ChainRow {
  id: string;
  patient_id: string;
  professional_id: string;
  sequence_number: bigint;
  entry_type: string;
  fhir_resource_type: string;
  content: unknown;
  consultation_id: string | null;
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
    //
    // El separador tiene que estar SOLO en su línea: el encabezado del .sql lo
    // menciona dentro de un comentario y un split por texto plano cortaba ahí,
    // dejando un fragmento que arrancaba en backtick (error 42601 en CI).
    for (const statement of readFileSync(SPIKE_SQL, 'utf8').split(
      /^--;;[ \t]*\r?$/m,
    )) {
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
        id, patient_id, professional_id, sequence_number, entry_type,
        fhir_resource_type, content, consultation_id, corrects_entry_id,
        content_hash, previous_hash, created_at
      ) values (
        ${entry.id ?? randomUUID()}::uuid,
        ${entry.patientId}::uuid,
        ${entry.professionalId}::uuid,
        ${entry.sequenceNumber}::bigint,
        ${entry.entryType},
        ${entry.fhirResourceType},
        ${JSON.stringify(entry.content)}::jsonb,
        ${entry.consultationId ?? null}::uuid,
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
      select id, patient_id, professional_id, sequence_number, entry_type,
             fhir_resource_type, content, consultation_id, corrects_entry_id,
             content_hash, previous_hash, created_at
        from spike_hash_chain_entries
       where patient_id = ${patientId}::uuid
       order by sequence_number`;

    return rows.map((row) => ({
      patientId: row.patient_id,
      professionalId: row.professional_id,
      sequenceNumber: Number(row.sequence_number),
      entryType: row.entry_type,
      fhirResourceType: row.fhir_resource_type,
      content: row.content,
      consultationId: row.consultation_id,
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

  describe('cobertura de la preimagen', () => {
    // Guarda contra la deriva: si ENG-57 agrega una columna a la tabla y no
    // decide si entra al hash, este test falla. Un campo fuera de la preimagen
    // es un campo modificable sin romper la cadena, y no hay nada más que avise.
    it('la preimagen cubre todas las columnas de la tabla', async () => {
      const rows = await prisma.$queryRaw<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_name = 'spike_hash_chain_entries'`;

      const enLaTabla = rows.map((r) => r.column_name).sort();
      const contabilizadas = [
        ...PREIMAGE_COLUMNS,
        ...NON_HASHED_COLUMNS,
      ].sort();

      expect(enLaTabla).toEqual(contabilizadas);
    });
  });

  describe('detección de manipulación', () => {
    it('detecta la reasignación del profesional que firmó la entrada', async () => {
      // El ataque más barato: no hace falta falsificar el diagnóstico si
      // alcanza con cambiar quién lo firmó (Ley 26.529 art. 15).
      const { patientId } = await seedChain(3);
      await tamper(
        `update spike_hash_chain_entries
            set professional_id = '33333333-3333-4333-8333-333333333333'
          where patient_id = '${patientId}' and sequence_number = 2`,
      );

      const result = verifyChain(await readChain(patientId));

      expect(result.valid).toBe(false);
      expect(result).toMatchObject({
        failure: { sequenceNumber: 2, reason: 'CONTENT_TAMPERED' },
      });
    });

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

  describe('límites conocidos', () => {
    // Este test afirma que la cadena NO detecta algo. Está acá a propósito:
    // deja el límite por escrito y ejecutable, para que nadie asuma que la
    // cadena sola alcanza. La mitigación es ENG-85 persistiendo la cabeza
    // (hash + sequence_number) de cada corrida, más el anclaje externo.
    it('NO detecta el truncado de la cola: hay que anclar la cabeza aparte', async () => {
      const { patientId } = await seedChain(6);
      await tamper(
        `delete from spike_hash_chain_entries
          where patient_id = '${patientId}' and sequence_number > 4`,
      );

      const chain = await readChain(patientId);
      const [sqlCheck] = await prisma.$queryRaw<VerifyRow[]>`
        select * from spike_hash_chain_verify(${patientId}::uuid)`;

      // Las 4 que quedan siguen contiguas, enlazadas y arrancando en el génesis.
      expect(chain).toHaveLength(4);
      expect(verifyChain(chain).valid).toBe(true);
      expect(sqlCheck.ok).toBe(true);
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
