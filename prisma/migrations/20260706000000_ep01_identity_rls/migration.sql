-- EP-01 · Identidad y Acceso — RLS de `profiles` y `patients` (ENG-37)
--
-- Versiona el patrón de Row Level Security validado en el spike ENG-37, alineado
-- con el modelo documentado en mediconnect-docs/modelo-de-datos/esquema.md.
--
-- Contrato de Supabase asumido por estas políticas:
--   * auth.uid() = (current_setting('request.jwt.claims')::jsonb ->> 'sub')::uuid
--     — el id del usuario autenticado, tomado del JWT.
--   * Las consultas de la app viajan con el rol de Postgres `authenticated`.
--   * El backend con la service key (rol `service_role`, BYPASSRLS) NO queda sujeto
--     a estas políticas: por eso el alta del perfil la hace un trigger con
--     SECURITY DEFINER y las operaciones administrativas no dependen de RLS.
--
-- Nota de adopción: el proyecto venía usando `prisma db push` (sin historial de
-- migraciones). Esta es la primera migración versionada; para aplicarla sobre una
-- base ya existente hay que baselinear (`prisma migrate resolve --applied ...`).
-- Todas las sentencias son idempotentes (IF EXISTS / OR REPLACE) para poder
-- reconciliar una base donde el trigger/políticas ya se aplicaron a mano.

-- ---------------------------------------------------------------------------
-- 1) Alta automática del perfil al registrarse en Supabase Auth
-- ---------------------------------------------------------------------------
-- Corre como SECURITY DEFINER (dueño del schema) → bypassa RLS para poder crear
-- la fila de `profiles`. El rol se toma del metadata del signUp; por defecto
-- PACIENTE (el registro de ENG-42 es de pacientes).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'role', '')::public.user_role,
      'PACIENTE'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- GRANTS de tabla — IMPRESCINDIBLE cuando las tablas las crea Prisma
-- ---------------------------------------------------------------------------
-- Supabase concede privilegios a `anon`/`authenticated` automáticamente a las
-- tablas creadas vía su API/Studio, pero NO a las creadas por Prisma (owner
-- `postgres`). Sin estos GRANT, el rol `authenticated` recibe "permission denied"
-- antes de que RLS siquiera evalúe las filas. RLS filtra filas; los GRANT dan
-- acceso a la tabla. Se necesitan ambos.
--
-- A `anon` NO se le concede nada sobre estas tablas con PII → queda denegado a
-- nivel privilegio (deny-all fuerte). `authenticated` recibe solo lo que sus
-- políticas permiten a nivel fila.
grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.patients to authenticated;

-- ---------------------------------------------------------------------------
-- 2) profiles — cada usuario ve y actualiza SOLO su propia fila
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select
  using (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- Sin políticas de INSERT/DELETE para `authenticated` → denegadas por defecto
-- (deny-all). El alta la hace el trigger; la baja cascadea desde auth.users.

-- Endurecimiento: impedir que un usuario escale su propio rol vía UPDATE.
-- Sin esto, la política de arriba dejaría a un PACIENTE hacer
-- `update profiles set role = 'MODERADOR' where id = auth.uid()`.
create or replace function public.prevent_profile_role_change()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role then
    raise exception 'No se permite modificar el rol del perfil';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_role_change on public.profiles;
create trigger profiles_prevent_role_change
  before update on public.profiles
  for each row execute function public.prevent_profile_role_change();

-- ---------------------------------------------------------------------------
-- 3) patients — el propio paciente (lectura/escritura).
--    La lectura por un profesional con turno vigente se agrega en EP-03
--    (requiere la tabla `appointments`, aún inexistente): patrón documentado
--    al pie para no dejar una referencia a una tabla que no existe.
-- ---------------------------------------------------------------------------
alter table public.patients enable row level security;

drop policy if exists patients_select_own on public.patients;
create policy patients_select_own on public.patients
  for select
  using (profile_id = auth.uid());

drop policy if exists patients_insert_own on public.patients;
create policy patients_insert_own on public.patients
  for insert
  with check (profile_id = auth.uid());

drop policy if exists patients_update_own on public.patients;
create policy patients_update_own on public.patients
  for update
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- Patrón EP-03 (se habilitará al existir `appointments`):
--   create policy patients_select_related_professional on public.patients
--     for select using (
--       exists (
--         select 1 from public.appointments a
--         where a.patient_id = patients.profile_id
--           and a.professional_id = auth.uid()
--       )
--     );
