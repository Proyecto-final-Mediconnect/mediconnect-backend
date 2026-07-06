// ENG-37 — Validación empírica de RLS (EP-01: profiles / patients) DESDE PRISMA.
//
// Prueba, contra la base real, que las políticas de Row Level Security aíslan los
// datos entre usuarios cuando se consultan con el patrón que usará el backend:
// una transacción de Prisma que adopta el rol `authenticated` y publica el claim
// `sub` del JWT (lo que en Supabase alimenta a auth.uid()). Sin ese patrón, Prisma
// conecta como `postgres` y NO queda sujeto a RLS.
//
// Requisitos previos:
//   1. .env con DATABASE_URL (conexión directa, 5432), SUPABASE_URL y
//      SUPABASE_SERVICE_ROLE_KEY del proyecto mediconnect-dev.
//   2. Migración aplicada:
//        node node_modules/prisma/build/index.js db execute \
//          --file prisma/migrations/20260706000000_ep01_identity_rls/migration.sql \
//          --schema prisma/schema.prisma
//   3. Client generado:  node node_modules/prisma/build/index.js generate
//
// Ejecutar:  node --env-file=.env --import tsx scripts/verify-rls.ts
//
// Crea 2 usuarios de prueba vía Admin API, corre las aserciones y los borra al
// final (con limpieza incluso ante error).

import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '../generated/prisma/client';

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DATABASE_URL) {
    console.error(
      '❌ Faltan variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y DATABASE_URL en .env',
    );
    process.exit(1);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const prisma = new PrismaClient();

  let allOk = true;
  const check = (name: string, condition: boolean): void => {
    console.log(`${condition ? '✅' : '❌'} ${name}`);
    if (!condition) allOk = false;
  };

  // Corre `work(tx)` como usuario autenticado: adopta el rol `authenticated` y
  // publica el claim `sub`. Es el patrón exacto a usar en el backend con Prisma.
  const asUser = <T>(
    sub: string,
    work: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('set local role authenticated');
      await tx.$executeRawUnsafe(
        "select set_config('request.jwt.claims', $1, true)",
        JSON.stringify({ sub, role: 'authenticated' }),
      );
      return work(tx as unknown as PrismaClient);
    });

  // Corre `work(tx)` como visitante anónimo (rol `anon`, sin claims).
  const asAnon = <T>(work: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('set local role anon');
      return work(tx as unknown as PrismaClient);
    });

  let A = '';
  let B = '';
  try {
    const stamp = Date.now();
    const { data: da, error: ea } = await admin.auth.admin.createUser({
      email: `eng37.a.${stamp}@test.mediconnect.dev`,
      password: 'Password1',
      email_confirm: true,
    });
    const { data: db, error: eb } = await admin.auth.admin.createUser({
      email: `eng37.b.${stamp}@test.mediconnect.dev`,
      password: 'Password1',
      email_confirm: true,
    });
    if (ea || eb) throw new Error(`createUser falló: ${(ea ?? eb)!.message}`);
    A = da.user!.id;
    B = db.user!.id;
    console.log(`Usuarios de prueba:\n  A=${A}\n  B=${B}\n`);

    // Cada usuario crea SU fila de patients (prueba la policy de INSERT).
    await asUser(A, (tx) =>
      tx.$executeRawUnsafe(
        "insert into patients (profile_id, first_name, last_name) values ($1::uuid, 'Ana', 'Paciente')",
        A,
      ),
    );
    await asUser(B, (tx) =>
      tx.$executeRawUnsafe(
        "insert into patients (profile_id, first_name, last_name) values ($1::uuid, 'Beto', 'Paciente')",
        B,
      ),
    );

    // --- Aislamiento actuando como A ---
    const profSeen = await asUser<Row[]>(A, (tx) =>
      tx.$queryRawUnsafe('select id from profiles'),
    );
    check(
      'profiles: A solo ve su propia fila (el trigger la creó al registrarse)',
      profSeen.length === 1 && profSeen[0].id === A,
    );

    const patSeen = await asUser<Row[]>(A, (tx) =>
      tx.$queryRawUnsafe('select profile_id from patients'),
    );
    check(
      'patients: A solo ve su propia fila',
      patSeen.length === 1 && patSeen[0].profile_id === A,
    );

    const bProfileFromA = await asUser<Row[]>(A, (tx) =>
      tx.$queryRawUnsafe('select id from profiles where id = $1::uuid', B),
    );
    check('profiles: A NO puede leer la fila de B', bProfileFromA.length === 0);

    const bPatientFromA = await asUser<Row[]>(A, (tx) =>
      tx.$queryRawUnsafe(
        'select profile_id from patients where profile_id = $1::uuid',
        B,
      ),
    );
    check('patients: A NO puede leer la fila de B', bPatientFromA.length === 0);

    const updated = await asUser<number>(A, (tx) =>
      tx.$executeRawUnsafe(
        "update profiles set email = 'hackeado@test.dev' where id = $1::uuid",
        B,
      ),
    );
    check(
      'profiles: el UPDATE de A sobre la fila de B afecta 0 filas',
      updated === 0,
    );

    // Escalada de privilegios: A intenta convertirse en MODERADOR sobre su fila.
    let roleEscalationBlocked = false;
    try {
      await asUser(A, (tx) =>
        tx.$executeRawUnsafe(
          "update profiles set role = 'MODERADOR' where id = $1::uuid",
          A,
        ),
      );
    } catch {
      roleEscalationBlocked = true;
    }
    check(
      'profiles: A NO puede auto-escalar su rol a MODERADOR',
      roleEscalationBlocked,
    );

    // Deny-all para anónimo: sin GRANT a `anon`, la lectura es denegada a nivel
    // privilegio (error). Aceptamos tanto el error como 0 filas: ambos = no accede.
    let anonDenied = false;
    try {
      const anonSeen = await asAnon<Row[]>((tx) =>
        tx.$queryRawUnsafe('select id from profiles'),
      );
      anonDenied = anonSeen.length === 0;
    } catch {
      anonDenied = true;
    }
    check(
      'profiles: un anónimo no accede a ninguna fila (deny-all)',
      anonDenied,
    );

    console.log(
      `\n${allOk ? '✅ TODAS las verificaciones de RLS pasaron' : '❌ Hubo fallos de aislamiento — revisar arriba'}`,
    );
  } finally {
    // Borrar el usuario de Auth cascadea sus filas de profiles y patients
    // (FK ON DELETE CASCADE). Cada borrado va aislado para que un fallo no impida
    // los demás.
    for (const id of [A, B].filter(Boolean)) {
      try {
        await admin.auth.admin.deleteUser(id);
      } catch (e) {
        console.error(
          `⚠️  No se pudo borrar el usuario ${id}:`,
          (e as Error).message,
        );
      }
    }
    console.log('🧹 Usuarios y filas de prueba eliminados.');
    await prisma.$disconnect();
  }

  process.exit(allOk ? 0 : 1);
}

void main();
