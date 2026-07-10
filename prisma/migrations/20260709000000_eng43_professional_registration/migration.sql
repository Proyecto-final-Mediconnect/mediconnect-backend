-- EP-01 · Registro como profesional (ENG-43)
--
-- Extiende el alta automática de usuario: cuando el signUp trae role=PROFESIONAL
-- en raw_user_meta_data, además del perfil se crea la fila en `professionals`
-- (estado PENDIENTE_VALIDACION_MATRICULA; la matrícula se valida a mano en el
-- MVP). Y habilita la RLS de `professionals`.
--
-- La tabla `professionals` y el enum `professional_status` ya los crea
-- 20260705000000_ep01_base_tables; acá sólo se agrega comportamiento (trigger +
-- RLS), idempotente y consistente con la migración Supabase equivalente
-- (supabase/migrations/20260706120000_eng43_professionals.sql).

-- ---------------------------------------------------------------------------
-- 1) Alta automática: perfil + (si es profesional) fila en professionals
-- ---------------------------------------------------------------------------
-- Reemplaza la versión de ENG-37 (solo perfil) agregando la rama de profesional.
-- SECURITY DEFINER → corre como owner del schema y bypassa RLS para el alta.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.user_role := coalesce(
    nullif(new.raw_user_meta_data ->> 'role', '')::public.user_role,
    'PACIENTE'
  );
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, v_role)
  on conflict (id) do nothing;

  -- Nuevo (ENG-43): si es profesional, crea su fila en estado pendiente.
  -- Los datos viajan en el metadata del signUp; la especialidad se asigna en la
  -- validación manual (no se persiste como columna acá).
  if v_role = 'PROFESIONAL' then
    insert into public.professionals (profile_id, first_name, last_name, license_number)
    values (
      new.id,
      coalesce(new.raw_user_meta_data ->> 'first_name', ''),
      coalesce(new.raw_user_meta_data ->> 'last_name', ''),
      coalesce(new.raw_user_meta_data ->> 'license_number', '')
    )
    on conflict (profile_id) do nothing;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) professionals — GRANTs + RLS
-- ---------------------------------------------------------------------------
-- Igual que profiles/patients: sin GRANT, `authenticated` recibe "permission
-- denied" antes de que RLS evalúe. El alta la hace el trigger (SECURITY DEFINER)
-- y la escritura administrativa el service_role (BYPASSRLS); por eso solo se
-- concede SELECT y una política de lectura de la propia fila.
grant select on public.professionals to authenticated;

alter table public.professionals enable row level security;

drop policy if exists professionals_select_own on public.professionals;
create policy professionals_select_own on public.professionals
  for select
  using (profile_id = auth.uid());
