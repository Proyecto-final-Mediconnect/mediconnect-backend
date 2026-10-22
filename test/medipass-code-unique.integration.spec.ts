import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * Migración de unicidad del código MediPass (ENG-170, hallazgo 1 de ENG-105).
 *
 * ## Por qué esto existe
 *
 * El CI de integración prepara la base con `prisma db push`
 * (`scripts/test-integration.sh`), **no** con `prisma migrate deploy`. Eso
 * significa que el SQL de los archivos de migración no lo ejecuta nadie hasta el
 * deploy a producción: `db push` deriva el esquema del `schema.prisma` y se saltea
 * las migraciones por completo.
 *
 * Para la mayoría de las migraciones da igual, porque el resultado es el mismo
 * esquema. Acá no: el paso de deduplicación de esta migración es lógica que
 * **solo** corre una vez, en producción, sobre datos que nadie vio todavía —la
 * migración de #68 nunca corrió contra una base real—. Si está mal, el deploy se
 * cae y encima quedó a mitad de camino.
 *
 * Así que este spec carga el archivo de migración statement por statement y lo
 * ejecuta contra Postgres de verdad, igual que los specs de ENG-57 y ENG-126.
 *
 * ## Qué hace con el estado compartido
 *
 * `db push` ya creó `medipass_codes_code_key` desde el `@unique` del esquema, así
 * que para poder insertar duplicados hay que bajarlo primero. Se restaura en el
 * `afterAll`: los specs de integración comparten base y corren en serie
 * (`--runInBand`), y dejar la tabla sin la unique afectaría a cualquiera que
 * corra después.
 */

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261021030000_eng170_medipass_code_unique',
  'migration.sql',
);

const UNIQUE_INDEX = 'medipass_codes_code_key';

/** Carga un archivo de migración statement por statement (separador `--;;`). */
async function applyMigration(prisma: PrismaClient, path: string) {
  for (const statement of readFileSync(path, 'utf8').split(
    /^--;;[ \t]*\r?$/m,
  )) {
    const sql = statement.trim();
    if (sql.length > 0) await prisma.$executeRawUnsafe(sql);
  }
}

describe('Unicidad del código MediPass (integration)', () => {
  const prisma = new PrismaClient();

  const PATIENT = randomUUID();
  const createdCodes: string[] = [];

  /** Inserta un código con `created_at` controlado, salteando la unique. */
  async function insertCode(code: string, createdAt: Date): Promise<string> {
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `insert into public.medipass_codes (id, patient_id, code, expires_at, created_at)
       values ($1::uuid, $2::uuid, $3, now() + interval '5 minutes', $4::timestamptz)`,
      id,
      PATIENT,
      code,
      createdAt.toISOString(),
    );
    createdCodes.push(id);
    return id;
  }

  /** Le cuelga una sesión al código, que es lo que lo vuelve no borrable. */
  async function insertSession(codeId: string): Promise<void> {
    await prisma.mediPassSession.create({
      data: {
        patient_id: PATIENT,
        medipass_code_id: codeId,
        consultant_name: 'Dr. Integration',
        expires_at: new Date(Date.now() + 30 * 60_000),
      },
    });
  }

  async function codigosVivos(code: string): Promise<string[]> {
    const rows = await prisma.mediPassCode.findMany({
      where: { code },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async function indiceExiste(): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'medipass_codes'
         and indexname = $1`,
      UNIQUE_INDEX,
    );
    return rows.length > 0;
  }

  beforeAll(async () => {
    await prisma.profile.create({
      data: {
        id: PATIENT,
        email: `paciente-${PATIENT}@test.local`,
        role: 'PACIENTE',
      },
    });
    await prisma.patient.create({
      data: {
        profile_id: PATIENT,
        first_name: 'Test',
        last_name: 'CodeUnique',
      },
    });
  });

  beforeEach(async () => {
    // Bajar la unique que dejó `db push`, para poder sembrar duplicados.
    await prisma.$executeRawUnsafe(
      `drop index if exists public."${UNIQUE_INDEX}"`,
    );
  });

  afterEach(async () => {
    await prisma.mediPassSession.deleteMany({ where: { patient_id: PATIENT } });
    await prisma.mediPassCode.deleteMany({ where: { patient_id: PATIENT } });
    createdCodes.length = 0;
  });

  afterAll(async () => {
    // Dejar la tabla como la espera el resto de la suite.
    await prisma.$executeRawUnsafe(
      `create unique index if not exists "${UNIQUE_INDEX}" on public.medipass_codes ("code")`,
    );
    await prisma.patient.deleteMany({ where: { profile_id: PATIENT } });
    await prisma.profile.deleteMany({ where: { id: PATIENT } });
    await prisma.$disconnect();
  });

  describe('deduplicación', () => {
    it('sin duplicados no borra nada y crea el índice', async () => {
      const soloUno = await insertCode('BCD23FGH', new Date());

      await applyMigration(prisma, MIGRATION);

      expect(await codigosVivos('BCD23FGH')).toEqual([soloUno]);
      expect(await indiceExiste()).toBe(true);
    });

    it('entre dos sin sesiones sobrevive la más nueva', async () => {
      const vieja = await insertCode(
        'JKLM2345',
        new Date('2026-10-20T10:00:00Z'),
      );
      const nueva = await insertCode(
        'JKLM2345',
        new Date('2026-10-20T11:00:00Z'),
      );

      await applyMigration(prisma, MIGRATION);

      const vivos = await codigosVivos('JKLM2345');
      expect(vivos).toEqual([nueva]);
      expect(vivos).not.toContain(vieja);
    });

    it('sobrevive la que tiene sesiones, aunque sea la más vieja', async () => {
      // Es el caso que obliga a NO quedarse siempre con la más nueva: la vieja
      // no se puede borrar (`ON DELETE RESTRICT`), así que si el criterio fuera
      // "la más nueva gana", ninguna de las dos calificaría y la migración se
      // plantaría sin necesidad.
      const conSesion = await insertCode(
        'NPQR2345',
        new Date('2026-10-20T10:00:00Z'),
      );
      await insertSession(conSesion);
      await insertCode('NPQR2345', new Date('2026-10-20T11:00:00Z'));

      await applyMigration(prisma, MIGRATION);

      expect(await codigosVivos('NPQR2345')).toEqual([conSesion]);
    });

    it('con tres repetidos deja solo la que tiene sesiones', async () => {
      const conSesion = await insertCode(
        'STVW2345',
        new Date('2026-10-20T10:00:00Z'),
      );
      await insertSession(conSesion);
      await insertCode('STVW2345', new Date('2026-10-20T11:00:00Z'));
      await insertCode('STVW2345', new Date('2026-10-20T12:00:00Z'));

      await applyMigration(prisma, MIGRATION);

      expect(await codigosVivos('STVW2345')).toEqual([conSesion]);
    });

    it('no toca códigos de otros pacientes ni otros valores', async () => {
      const otro = await insertCode('XZBC2345', new Date());
      await insertCode('DFGH2345', new Date('2026-10-20T10:00:00Z'));
      await insertCode('DFGH2345', new Date('2026-10-20T11:00:00Z'));

      await applyMigration(prisma, MIGRATION);

      expect(await codigosVivos('XZBC2345')).toEqual([otro]);
      expect(await codigosVivos('DFGH2345')).toHaveLength(1);
    });
  });

  describe('cuando la deduplicación no alcanza', () => {
    it('falla con un mensaje que dice qué revisar, y no crea el índice', async () => {
      // Dos filas con el mismo código y las dos usadas: la colisión ocurrió y
      // alguien pudo haber visto la ficha de otro paciente. Eso no se resuelve
      // borrando a ciegas en una migración.
      const unaUsada = await insertCode(
        'KLMN2345',
        new Date('2026-10-20T10:00:00Z'),
      );
      const otraUsada = await insertCode(
        'KLMN2345',
        new Date('2026-10-20T11:00:00Z'),
      );
      await insertSession(unaUsada);
      await insertSession(otraUsada);

      await expect(applyMigration(prisma, MIGRATION)).rejects.toThrow(
        /ENG-170/,
      );

      // Las dos filas siguen ahí y el índice no se creó: la migración no aplicó.
      expect(await codigosVivos('KLMN2345')).toHaveLength(2);
      expect(await indiceExiste()).toBe(false);
    });
  });

  describe('el índice', () => {
    it('rechaza un segundo código con el mismo valor', async () => {
      // Es el arreglo: a partir de acá la colisión deja de ser silenciosa y el
      // service la ve como `P2002` para reintentar con otro código.
      await insertCode('WXZB2345', new Date());
      await applyMigration(prisma, MIGRATION);

      await expect(insertCode('WXZB2345', new Date())).rejects.toThrow();
    });

    it('es idempotente: aplicarla dos veces no falla', async () => {
      await insertCode('CDFG2345', new Date());

      await applyMigration(prisma, MIGRATION);
      await expect(applyMigration(prisma, MIGRATION)).resolves.toBeUndefined();

      expect(await indiceExiste()).toBe(true);
    });

    it('sigue conviviendo con el índice de #68 sobre (code, expires_at)', async () => {
      // El canje filtra por las dos columnas y lo usa; este no lo reemplaza.
      await applyMigration(prisma, MIGRATION);

      const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
        `select indexname from pg_indexes
         where schemaname = 'public' and tablename = 'medipass_codes'`,
      );
      const nombres = rows.map((r) => r.indexname);

      expect(nombres).toContain(UNIQUE_INDEX);
      expect(nombres).toContain('medipass_codes_code_expires_at_idx');
    });
  });
});
