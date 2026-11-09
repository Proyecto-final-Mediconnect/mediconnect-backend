-- EP-01 · Verificación en dos pasos (ENG-88): que la base también la exija
--
-- El backend no acepta una sesión sin el segundo paso (`aal1`) de quien activó
-- la verificación (`JwtAuthGuard`). Pero la anon key es pública y con ella se
-- llega a Supabase directo (PostgREST, Storage, Realtime), salteando el
-- backend. Dos huecos que cierra esta migración:
--
-- 1. `profiles.mfa_enabled` lo podía escribir el propio usuario: ENG-37 le da
--    `update` sobre `profiles` a `authenticated`, la política
--    `profiles_update_own` deja tocar la fila propia y el trigger de ENG-37
--    solo protege `role`. Un `PATCH {"mfa_enabled": false}` con el token del
--    primer paso apagaba el control del guard.
-- 2. Ninguna política miraba el `aal` del JWT: con solo la contraseña se leían
--    directo la HC, los mensajes, los turnos, los pagos y los documentos del
--    bucket `patient-documents`, y se recibían por Realtime.
--
-- Las líneas `--;;` marcan el corte entre sentencias para que el spec de
-- integración cargue el archivo statement por statement. Todo idempotente.

-- ---------------------------------------------------------------------------
-- 1) `mfa_enabled` solo lo cambia el backend
-- ---------------------------------------------------------------------------
-- Mismo patrón que `prevent_profile_role_change` (ENG-37), con una diferencia:
-- el backend sí tiene que poder cambiarla (activar y desactivar la
-- verificación). Se bloquea a los roles de la API de Supabase (`authenticated`
-- y `anon`), que es como llegan las requests de PostgREST; el backend entra
-- por Prisma con su propio rol (`postgres` o `mediconnect_backend`, ENG-138) y
-- un administrador desde el panel o el SQL editor también.
--
-- **No** es `security definer` a propósito: `current_user` tiene que ser el rol
-- de quien hace el UPDATE, no el dueño de la función.
--;;
create or replace function public.prevent_profile_mfa_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.mfa_enabled is distinct from old.mfa_enabled
     and current_user in ('authenticated', 'anon') then
    raise exception 'No se permite modificar mfa_enabled del perfil'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
--;;
drop trigger if exists profiles_prevent_mfa_change on public.profiles;
--;;
create trigger profiles_prevent_mfa_change
  before update on public.profiles
  for each row execute function public.prevent_profile_mfa_change();

-- ---------------------------------------------------------------------------
-- 2) `public.mfa_ok()`: ¿la sesión cumple con la verificación en dos pasos?
-- ---------------------------------------------------------------------------
-- `true` si el token ya tiene el segundo paso (`aal2`) o si la persona no tiene
-- ningún factor verificado (no la activó). Es la regla que recomienda Supabase
-- para exigir MFA solo a quien la activó, y mira `auth.mfa_factors` y no
-- `profiles.mfa_enabled`: la fuente de verdad es Supabase Auth.
--
-- `security definer` con `search_path` vacío: lee `auth.mfa_factors` con los
-- permisos del dueño (el que corre las migraciones) y no resuelve nombres
-- contra un `search_path` ajeno. Solo devuelve un booleano sobre el propio
-- usuario del JWT, así que no expone nada.
--
-- plpgsql y no sql: plpgsql no valida al crear que existan `auth.jwt()` ni
-- `auth.mfa_factors`, que no están en el Postgres de CI. Si falta la tabla
-- (Postgres local sin Supabase Auth) no hay forma de tener un factor y
-- devuelve `true`.
--;;
create or replace function public.mfa_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'aal', '') = 'aal2' then
    return true;
  end if;
  if to_regclass('auth.mfa_factors') is null then
    return true;
  end if;
  return not exists (
    select 1
      from auth.mfa_factors f
     where f.user_id = auth.uid()
       and f.status = 'verified'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Políticas restrictivas: sin el segundo paso no se ve ni se toca nada
-- ---------------------------------------------------------------------------
-- `as restrictive` se suma con AND a las políticas que ya existen: no da
-- acceso a nada nuevo, solo lo quita a una sesión `aal1` de quien activó la
-- verificación. Es `to authenticated`: el backend (service role o el rol de
-- ENG-138, los dos con BYPASSRLS) y el dueño de las tablas no quedan sujetos.
--
-- `(select public.mfa_ok())` y no `public.mfa_ok()`: así Postgres la evalúa una
-- vez por consulta (initplan) y no una por fila.
--
-- Las tablas son las de datos de personas que tienen RLS. Las de catálogo
-- (`specialties`) quedan afuera. Realtime (`postgres_changes`) evalúa la RLS
-- de la tabla con el JWT del suscriptor, así que `messages` y
-- `notifications` cubren también ese camino; el Broadcast del "escribiendo"
-- va por `realtime.messages`.
--
-- Se saltea donde no están las piezas de Supabase (Postgres de CI): sin el rol
-- `authenticated` no hay a quién aplicarla, y sin `auth.jwt()`/`auth.uid()` la
-- política fallaría en cada consulta. El DDL de `storage` y `realtime` va por
-- `execute` para que ni se parsee si esos schemas no existen (ENG-48, ENG-70).
--;;
do $do$
declare
  t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated')
     or to_regprocedure('auth.jwt()') is null
     or to_regprocedure('auth.uid()') is null then
    raise notice
      'ENG-88: sin rol "authenticated" o sin auth.jwt()/auth.uid() (Postgres local) — se saltean las políticas de MFA';
    return;
  end if;

  execute 'grant execute on function public.mfa_ok() to authenticated';

  -- Que la función corra antes de colgarla de todas las tablas: si el dueño no
  -- pudiera leer `auth.mfa_factors`, la migración falla acá y no deja a todos
  -- los usuarios sin poder leer nada.
  perform public.mfa_ok();

  foreach t in array array[
    'profiles',
    'patients',
    'professionals',
    'professional_specialties',
    'schedule_rules',
    'schedule_blocks',
    'appointments',
    'payments',
    'refunds',
    'clinical_record_entries',
    'patient_documents',
    'conversations',
    'messages',
    'notifications',
    'video_sessions',
    'medipass_codes',
    'medipass_sessions',
    'medipass_access_logs',
    'medipass_emergency_cards',
    'legal_acceptances',
    'audit_logs'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('drop policy if exists mfa_aal2_required on public.%I', t);
    execute format(
      'create policy mfa_aal2_required on public.%I
         as restrictive
         for all
         to authenticated
         using ((select public.mfa_ok()))
         with check ((select public.mfa_ok()))',
      t
    );
  end loop;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists mfa_aal2_required on storage.objects';
    execute $sql$
      create policy mfa_aal2_required on storage.objects
        as restrictive
        for all
        to authenticated
        using ((select public.mfa_ok()))
        with check ((select public.mfa_ok()))
    $sql$;
  else
    raise notice 'ENG-88: schema "storage" ausente — se saltea la política de MFA en storage.objects';
  end if;

  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists mfa_aal2_required on realtime.messages';
    execute $sql$
      create policy mfa_aal2_required on realtime.messages
        as restrictive
        for all
        to authenticated
        using ((select public.mfa_ok()))
        with check ((select public.mfa_ok()))
    $sql$;
  end if;
end
$do$;
