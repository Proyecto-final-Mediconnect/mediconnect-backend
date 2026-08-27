import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';
import {
  appendEntry,
  chainEntryFromRow,
  GENESIS_HASH,
  NON_HASHED_COLUMNS,
  PREIMAGE_COLUMNS,
  verifyChain,
  type ChainEntry,
  type ChainEntryInput,
  type ChainEntryRow,
} from '../src/common/hash-chain/hash-chain';

/**
 * Modelo de datos de la HC contra Postgres real (ENG-57).
 *
 * Es el test que le da valor a la migración: que la tabla sea append-only de
 * verdad, que rechace una cadena mal encadenada y que la política de RLS deje ver
 * al paciente solo lo suyo. Nada de eso se puede probar con Prisma mockeado.
 *
 * **Es el primer test del repo que ejercita una migración y una política de RLS.**
 * Hasta acá no se podía: `test:integration` aplica el esquema con `prisma db
 * push`, que crea tablas pero no corre SQL, y el Postgres de tests no emula
 * Supabase — no existen el rol `authenticated` ni `auth.uid()`. El `beforeAll`
 * crea esas dos piezas (las mismas que `db/bootstrap/00_supabase_local.sql` arma
 * para el Postgres de desarrollo) y recién después carga la migración.
 *
 * Todos los recursos FHIR son sintéticos.
 */

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260826120000_eng57_clinical_record_chain',
  'migration.sql',
);

const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';

describe('Historia clínica con cadena de hash (integration)', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    // Piezas que en producción trae Supabase y que este Postgres no tiene.
    // `auth.uid()` lee el mismo claim que en Supabase, así que la política de la
    // migración se evalúa exactamente igual acá que allá.
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

    for (const statement of readFileSync(MIGRATION, 'utf8').split(
      /^--;;[ \t]*\r?$/m,
    )) {
      const sql = statement.trim();
      if (sql.length > 0) await prisma.$executeRawUnsafe(sql);
    }
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function entryInput(
    patientId: string,
    sequenceNumber: number,
    value = 70,
  ): ChainEntryInput {
    return {
      patientId,
      professionalId: PROFESSIONAL,
      sequenceNumber,
      entryType: 'CONSULTA',
      fhirResourceType: 'Observation',
      content: {
        resourceType: 'Observation',
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
        valueQuantity: { value, unit: '/min' },
      },
      // Milisegundos: la columna es timestamptz(3) y el valor lo pone la app.
      createdAt: new Date(Date.UTC(2026, 7, 27, 12, 0, sequenceNumber)),
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

  /** Siembra `n` entradas selladas para un paciente nuevo. */
  async function seedChain(n: number) {
    const patientId = randomUUID();
    let previousHash = GENESIS_HASH;

    for (let i = 1; i <= n; i++) {
      const entry = appendEntry(entryInput(patientId, i, 60 + i), previousHash);
      await insert(entry);
      previousHash = entry.contentHash;
    }

    return { patientId, head: previousHash };
  }

  async function readChain(patientId: string): Promise<ChainEntry[]> {
    const rows = await prisma.$queryRaw<ChainEntryRow[]>`
      select patient_id, professional_id, sequence_number, entry_type,
             fhir_resource_type, content, consultation_id, corrects_entry_id,
             created_at, content_hash, previous_hash
        from clinical_record_entries
       where patient_id = ${patientId}::uuid
       order by sequence_number`;

    return rows.map(chainEntryFromRow);
  }

  describe('append-only (Ley 26.529 art. 15)', () => {
    it('rechaza UPDATE sobre una entrada de HC', async () => {
      const { patientId } = await seedChain(1);

      await expect(
        prisma.$executeRawUnsafe(
          `update clinical_record_entries set fhir_resource_type = 'Condition'
             where patient_id = '${patientId}'`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('rechaza DELETE sobre una entrada de HC', async () => {
      const { patientId } = await seedChain(1);

      await expect(
        prisma.$executeRawUnsafe(
          `delete from clinical_record_entries where patient_id = '${patientId}'`,
        ),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('encadenamiento verificado en el INSERT', () => {
    it('rechaza una primera entrada que no arranca en el génesis', async () => {
      const entry = appendEntry(entryInput(randomUUID(), 1), 'a'.repeat(64));

      await expect(insert(entry)).rejects.toThrow(/hash génesis/);
    });

    it('rechaza una primera entrada con sequence_number distinto de 1', async () => {
      const entry = appendEntry(entryInput(randomUUID(), 5), GENESIS_HASH);

      await expect(insert(entry)).rejects.toThrow(/sequence_number 1/);
    });

    it('rechaza un previous_hash que no es la cabeza de la cadena', async () => {
      const { patientId } = await seedChain(2);
      const entry = appendEntry(entryInput(patientId, 3), 'b'.repeat(64));

      await expect(insert(entry)).rejects.toThrow(/previous_hash no coincide/);
    });

    it('rechaza un sequence_number no contiguo', async () => {
      const { patientId, head } = await seedChain(2);
      const entry = appendEntry(entryInput(patientId, 9), head);

      await expect(insert(entry)).rejects.toThrow(/no contiguo/);
    });

    it('acepta la entrada siguiente bien encadenada', async () => {
      const { patientId, head } = await seedChain(2);
      const entry = appendEntry(entryInput(patientId, 3), head);

      await expect(insert(entry)).resolves.toBe(1);
      expect(verifyChain(await readChain(patientId)).valid).toBe(true);
    });
  });

  describe('formato de los hashes', () => {
    it('rechaza un hash que no es hexadecimal de 64', async () => {
      // `char(64)` acota el largo pero no el alfabeto: 64 espacios entrarían.
      const entry = appendEntry(entryInput(randomUUID(), 1), GENESIS_HASH);

      await expect(
        insert({ ...entry, contentHash: ' '.repeat(64) }),
      ).rejects.toThrow(/hash_hex/);
    });
  });

  describe('round-trip del hash contra la tabla real', () => {
    it('lo releído de la base reproduce el hash sellado', async () => {
      // Es el hallazgo de ENG-45 verificado sobre `clinical_record_entries`: con
      // `timestamptz(6)` los microsegundos se perderían acá y la entrada saldría
      // reportada como manipulada estando intacta.
      const { patientId } = await seedChain(3);

      const result = verifyChain(await readChain(patientId));

      expect(result).toMatchObject({ valid: true, entries: 3 });
    });
  });

  describe('cobertura de la preimagen', () => {
    it('la preimagen cubre todas las columnas de la tabla', async () => {
      // Guarda contra la deriva: un campo fuera de la preimagen es un campo
      // modificable sin romper la cadena, y no hay nada más que avise.
      const rows = await prisma.$queryRaw<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_name = 'clinical_record_entries'`;

      const enLaTabla = rows.map((r) => r.column_name).sort();
      const contabilizadas = [
        ...PREIMAGE_COLUMNS,
        ...NON_HASHED_COLUMNS,
      ].sort();

      expect(enLaTabla).toEqual(contabilizadas);
    });
  });

  describe('RLS: el paciente ve solo su propia HC', () => {
    /**
     * Corre `work` como el usuario autenticado, igual que el patrón que dejó
     * documentado el spike ENG-37: adoptar el rol `authenticated` y publicar el
     * claim `sub`, las dos cosas con `SET LOCAL` para que valgan solo dentro de
     * la transacción y no contaminen la conexión del pool.
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

    const count = (tx: PrismaClient, patientId: string) =>
      tx.$queryRaw<{ n: bigint }[]>`
        select count(*) as n from clinical_record_entries
         where patient_id = ${patientId}::uuid`;

    it('el dueño ve sus entradas', async () => {
      const { patientId } = await seedChain(3);

      const [{ n }] = await asUser(patientId, (tx) => count(tx, patientId));

      expect(Number(n)).toBe(3);
    });

    it('otro paciente no ve nada de esa HC', async () => {
      const { patientId } = await seedChain(3);
      const intruso = randomUUID();

      const [{ n }] = await asUser(intruso, (tx) => count(tx, patientId));

      expect(Number(n)).toBe(0);
    });

    it('el profesional que la escribió tampoco la ve todavía', async () => {
      // ENG-60 es quien decide y agrega esa política. Hasta entonces, la HC es
      // solo del paciente — cerrar y abrir después es más fácil que al revés.
      const { patientId } = await seedChain(2);

      const [{ n }] = await asUser(PROFESSIONAL, (tx) => count(tx, patientId));

      expect(Number(n)).toBe(0);
    });

    it('authenticated no puede insertar aunque la cadena cierre', async () => {
      // No hay GRANT de INSERT: el sellado lo hace el backend como owner.
      const patientId = randomUUID();
      const entry = appendEntry(entryInput(patientId, 1), GENESIS_HASH);

      await expect(
        asUser(patientId, (tx) =>
          tx.$executeRawUnsafe(
            `insert into clinical_record_entries
               (patient_id, professional_id, sequence_number, entry_type,
                fhir_resource_type, content, content_hash, previous_hash, created_at)
             values ('${patientId}', '${PROFESSIONAL}', 1, 'CONSULTA', 'Observation',
                     '{}'::jsonb, '${entry.contentHash}', '${GENESIS_HASH}', now())`,
          ),
        ),
      ).rejects.toThrow(/permission denied|denegado/i);
    });
  });
});
