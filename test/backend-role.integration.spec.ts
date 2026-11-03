import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';

/**
 * El rol con permisos mínimos del backend (ENG-138, parte 1), contra Postgres
 * de verdad.
 *
 * Aplica `prisma/sql/eng138-rol-backend.sql` tal cual se va a correr en
 * Supabase, le pone una contraseña de prueba, se conecta **como ese rol** y
 * comprueba las dos cosas que importan:
 *
 * 1. Que el backend puede hacer todo lo que hace hoy. La lista de escrituras
 *    sale de leer el código (cada `create`, `update`, `delete` y SQL crudo de
 *    `src/`). Si alguien agrega una escritura sobre una tabla nueva, este test
 *    es donde se suma.
 * 2. Que no puede lo que no tiene que poder: desactivar un trigger, hacer DDL,
 *    TRUNCATE, ni tocar una fila de las tablas append-only.
 */
const SCRIPT = join(__dirname, '..', 'prisma', 'sql', 'eng138-rol-backend.sql');

/** Lo que escribe el backend hoy, tabla por tabla (código de `src/`). */
const ESCRITURAS: Record<string, ('INSERT' | 'UPDATE' | 'DELETE')[]> = {
  appointments: ['INSERT', 'UPDATE'],
  audit_logs: ['INSERT'],
  cancellation_policies: ['INSERT', 'UPDATE'],
  chain_head_snapshots: ['INSERT', 'UPDATE'],
  clinical_record_entries: ['INSERT'],
  consultations: ['INSERT', 'UPDATE'],
  conversations: ['INSERT', 'UPDATE', 'DELETE'],
  integrity_checks: ['INSERT'],
  legal_acceptances: ['INSERT'],
  medipass_access_logs: ['INSERT'],
  medipass_codes: ['INSERT', 'UPDATE'],
  medipass_sessions: ['INSERT', 'UPDATE'],
  messages: ['INSERT', 'UPDATE'],
  notifications: ['INSERT', 'UPDATE', 'DELETE'],
  patient_documents: ['INSERT', 'UPDATE'],
  patients: ['UPDATE'],
  payment_webhook_events: ['INSERT', 'UPDATE'],
  payments: ['INSERT', 'UPDATE'],
  // ENG-86: la baja saca al profesional del catálogo.
  professionals: ['UPDATE'],
  profiles: ['UPDATE'],
  push_tokens: ['DELETE'],
  refunds: ['INSERT', 'UPDATE'],
  reviews: ['INSERT', 'UPDATE', 'DELETE'],
  schedule_blocks: ['DELETE'],
  schedule_rules: ['DELETE'],
  video_sessions: ['INSERT', 'UPDATE'],
};

const APPEND_ONLY = [
  'clinical_record_entries',
  'audit_logs',
  'medipass_access_logs',
  'legal_acceptances',
  'integrity_checks',
];

const PASSWORD = `test-${randomUUID()}`;

function urlComoRol(): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.username = 'mediconnect_backend';
  url.password = PASSWORD;
  return url.toString();
}

/** El SQLSTATE de un error de Postgres, venga como venga envuelto. */
async function sqlState(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
  } catch (error) {
    const e = error as { code?: string; meta?: { code?: string } };
    return (
      e.meta?.code ??
      String((error as Error).message).match(/\b(42501|42P01|0A000)\b/)?.[1] ??
      e.code ??
      '?'
    );
  }
  throw new Error('Se esperaba que fallara');
}

describe('Rol mínimo del backend (integration, ENG-138)', () => {
  const owner = new PrismaClient();
  let backend: PrismaClient;

  beforeAll(async () => {
    // El script entero, como se corre en el SQL Editor. Las sentencias se
    // separan por `;` al final de línea, salvo dentro del bloque `do $$ ... $$`.
    const sql = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    const bloques = sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean);
    const sentencias: string[] = [];
    for (let i = 0; i < bloques.length; i++) {
      if (bloques[i].startsWith('do $$')) {
        // Se vuelve a juntar el bloque partido por los `;` internos.
        let bloque = bloques[i];
        while (!bloque.includes('end $$')) bloque += ';\n' + bloques[++i];
        sentencias.push(bloque);
      } else {
        sentencias.push(bloques[i]);
      }
    }
    // En Supabase existe `postgres`, que es quien corre las migraciones y para
    // quien van los default privileges. El contenedor de tests no lo tiene.
    await owner.$executeRawUnsafe(
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = 'postgres') then
           create role postgres nologin;
         end if;
       end $$`,
    );
    // Dos veces: tiene que ser idempotente.
    for (let vuelta = 0; vuelta < 2; vuelta++) {
      for (const s of sentencias) await owner.$executeRawUnsafe(s);
    }
    await owner.$executeRawUnsafe(
      `alter role mediconnect_backend password '${PASSWORD}'`,
    );
    backend = new PrismaClient({ datasourceUrl: urlComoRol() });
  });

  afterAll(async () => {
    await backend.$disconnect();
    await owner.$disconnect();
  });

  it('el rol no es superusuario ni puede crear roles ni bases', async () => {
    const [rol] = await owner.$queryRawUnsafe<
      { rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }[]
    >(
      `select rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = 'mediconnect_backend'`,
    );
    expect(rol).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
  });

  it('no es dueño de ninguna tabla', async () => {
    const [{ count }] = await owner.$queryRawUnsafe<{ count: bigint }[]>(
      `select count(*) from pg_tables where schemaname = 'public' and tableowner = 'mediconnect_backend'`,
    );
    expect(Number(count)).toBe(0);
  });

  it('tiene todos los permisos que el backend usa hoy', async () => {
    const faltan: string[] = [];
    for (const [tabla, privilegios] of Object.entries(ESCRITURAS)) {
      for (const privilegio of ['SELECT', ...privilegios]) {
        const [{ ok }] = await owner.$queryRawUnsafe<{ ok: boolean }[]>(
          `select has_table_privilege('mediconnect_backend', $1, $2) as ok`,
          `public.${tabla}`,
          privilegio,
        );
        if (!ok) faltan.push(`${privilegio} ${tabla}`);
      }
    }
    expect(faltan).toEqual([]);
  });

  it('lee y escribe de verdad conectado como el rol', async () => {
    const id = randomUUID();
    await backend.profile.create({
      data: { id, email: `rol-${id}@test.local`, role: 'PACIENTE' },
    });
    await backend.profile.update({
      where: { id },
      data: { mfa_enabled: true },
    });
    const aviso = await backend.notification.create({
      data: { user_id: id, type: 'MEDIPASS_ACCESO', channel: 'IN_APP' },
    });
    expect(await backend.profile.count({ where: { id } })).toBe(1);

    // Y limpia lo suyo: el backend sí puede borrar avisos (la baja, ENG-86).
    await backend.notification.delete({ where: { id: aviso.id } });
    await backend.profile.delete({ where: { id } });
  });

  it.each(APPEND_ONLY)(
    'sobre %s no puede actualizar ni borrar',
    async (tabla) => {
      for (const privilegio of ['UPDATE', 'DELETE', 'TRUNCATE']) {
        const [{ ok }] = await owner.$queryRawUnsafe<{ ok: boolean }[]>(
          `select has_table_privilege('mediconnect_backend', $1, $2) as ok`,
          `public.${tabla}`,
          privilegio,
        );
        expect({ tabla, privilegio, ok }).toEqual({
          tabla,
          privilegio,
          ok: false,
        });
      }
    },
  );

  it('no puede borrar un documento aportado, solo marcar el retiro', async () => {
    const tiene = async (p: string) =>
      (
        await owner.$queryRawUnsafe<{ ok: boolean }[]>(
          `select has_table_privilege('mediconnect_backend', 'public.patient_documents', $1) as ok`,
          p,
        )
      )[0].ok;
    expect(await tiene('UPDATE')).toBe(true);
    expect(await tiene('DELETE')).toBe(false);
  });

  it('no puede desactivar un trigger: no es el dueño', async () => {
    expect(
      await sqlState(
        backend.$executeRawUnsafe(
          'alter table public.clinical_record_entries disable trigger all',
        ),
      ),
    ).toBe('42501');
  });

  it('no puede hacer DDL ni TRUNCATE', async () => {
    expect(
      await sqlState(backend.$executeRawUnsafe('drop table public.audit_logs')),
    ).toBe('42501');
    expect(
      await sqlState(
        backend.$executeRawUnsafe('truncate public.notifications'),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        backend.$executeRawUnsafe(
          'create table public.eng138_intruso (id int)',
        ),
      ),
    ).toBe('42501');
  });

  it('borrar una fila de la auditoría falla por permiso, antes que por el trigger', async () => {
    expect(
      await sqlState(
        backend.$executeRawUnsafe(
          `delete from public.audit_logs where action = 'NO_EXISTE'`,
        ),
      ),
    ).toBe('42501');
  });

  it('las tablas nuevas nacen con permisos de filas para el rol', async () => {
    await owner.$executeRawUnsafe(
      'create table if not exists public.eng138_nueva (id int)',
    );
    try {
      const [{ ok }] = await owner.$queryRawUnsafe<{ ok: boolean }[]>(
        `select has_table_privilege('mediconnect_backend', 'public.eng138_nueva', 'INSERT') as ok`,
      );
      // `owner` en los tests es el superusuario del contenedor, no `postgres`:
      // los default privileges son `for role postgres`, así que acá se
      // comprueba que la sentencia quedó registrada para ese rol.
      const defaults = await owner.$queryRawUnsafe<{ n: bigint }[]>(
        `select count(*) as n from pg_default_acl d join pg_roles r on r.oid = d.defaclrole
         where r.rolname = 'postgres' and d.defaclacl::text like '%mediconnect_backend%'`,
      );
      expect(ok || Number(defaults[0].n) > 0).toBe(true);
    } finally {
      await owner.$executeRawUnsafe('drop table if exists public.eng138_nueva');
    }
  });
});
