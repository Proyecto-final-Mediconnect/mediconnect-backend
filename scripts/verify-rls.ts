// ENG-37 — Validación empírica de RLS (EP-01: profiles / patients) DESDE PRISMA.
//
// Prueba, contra la base real, que las políticas de Row Level Security aíslan los
// datos entre usuarios cuando se consultan con el patrón que usará el backend:
// una transacción de Prisma que adopta el rol `authenticated` y publica el claim
// `sub` del JWT (lo que en Supabase alimenta a auth.uid()). Sin ese patrón, Prisma
// conecta como `postgres` y NO queda sujeto a RLS.
//
// Modos (se autodetecta según el .env):
//   * LOCAL (docker-compose, sin Supabase): basta DATABASE_URL. Los usuarios de
//     prueba se insertan directo en auth.users y el trigger on_auth_user_created
//     crea el profile — igual que hace GoTrue en prod.
//   * PROD/DEV (Supabase): además SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY del
//     proyecto mediconnect-dev; los usuarios se crean vía la Admin API de Auth.
//
// Requisitos comunes: migraciones aplicadas (prisma migrate deploy) y client
// generado (prisma generate).
//
// Ejecutar:  node --env-file=.env --import tsx scripts/verify-rls.ts
//
// Crea 2 usuarios de prueba, corre las aserciones y los borra al final (con
// limpieza incluso ante error).

import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '../generated/prisma/client';

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    console.error('❌ Falta DATABASE_URL en .env');
    process.exit(1);
  }

  // Si están las credenciales de Supabase, se usan usuarios reales vía Admin API
  // (prod/dev). Si no, modo local: usuarios directo en auth.users (dispara el
  // trigger que crea el profile). Así el mismo script corre contra el docker.
  const admin =
    SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
      ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;
  const prisma = new PrismaClient();

  // Alta de usuario de prueba, transparente al modo. Devuelve el id del usuario.
  const createTestUser = async (email: string): Promise<string> => {
    if (admin) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: 'Password1',
        email_confirm: true,
      });
      if (error) throw new Error(`createUser falló: ${error.message}`);
      return data.user!.id;
    }
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      'insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id',
      email,
    );
    return rows[0].id;
  };

  // Baja del usuario y sus filas. En prod la FK profiles→auth.users cascadea
  // todo; en local esa FK no existe, así que borramos profiles (cascadea
  // patients) y también la fila de auth.users.
  const deleteTestUser = async (id: string): Promise<void> => {
    if (admin) {
      await admin.auth.admin.deleteUser(id);
      return;
    }
    await prisma.$executeRawUnsafe(
      'delete from public.profiles where id = $1::uuid',
      id,
    );
    await prisma.$executeRawUnsafe(
      'delete from auth.users where id = $1::uuid',
      id,
    );
  };

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
    A = await createTestUser(`eng37.a.${stamp}@test.mediconnect.dev`);
    B = await createTestUser(`eng37.b.${stamp}@test.mediconnect.dev`);
    console.log(
      `Modo: ${admin ? 'Supabase Auth (prod/dev)' : 'local (auth.users)'}`,
    );
    console.log(`Usuarios de prueba:\n  A=${A}\n  B=${B}\n`);

    // Cada usuario crea SU fila de patients (prueba la policy de INSERT).
    await asUser(A, (tx) =>
      tx.$executeRawUnsafe(
        "insert into patients (profile_id, first_name, last_name) values ($1::uuid, 'Ana', 'Paciente')",
        A,
      ),
    );

    // Caso negativo del WITH CHECK: A NO puede insertar una fila de patients a
    // nombre de B. Se corre ANTES de que B cree la suya, así el único bloqueo es
    // la policy (profile_id = auth.uid()), no un choque de PK.
    let insertForOtherBlocked = false;
    try {
      await asUser(A, (tx) =>
        tx.$executeRawUnsafe(
          "insert into patients (profile_id, first_name, last_name) values ($1::uuid, 'Falso', 'Ajeno')",
          B,
        ),
      );
    } catch {
      insertForOtherBlocked = true;
    }
    check(
      'patients: A NO puede insertar una fila a nombre de B (WITH CHECK)',
      insertForOtherBlocked,
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
    // deleteTestUser borra el usuario y cascadea sus filas de profiles/patients.
    // Cada borrado va aislado para que un fallo no impida los demás.
    for (const id of [A, B].filter(Boolean)) {
      try {
        await deleteTestUser(id);
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
