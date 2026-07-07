-- ENG-43 — Registro como profesional
--
-- Crea el tipo `professional_status` y la tabla `professionals`, y extiende el
-- trigger on_auth_user_created para que, cuando el registro trae
-- role=PROFESIONAL en raw_user_meta_data, cree la fila de profesional en estado
-- PENDIENTE_VALIDACION_MATRICULA (validación de matrícula manual en el MVP).
--
-- NOTA: `handle_new_user` se reconcilió contra la definición vigente en Supabase
-- (verificada el 2026-07-06): hoy sólo inserta en `profiles` leyendo el rol del
-- metadata. Acá se preserva esa lógica idéntica (nullif + on conflict) y sólo se
-- agrega la rama de profesional. La especialidad entra por metadata y se asigna
-- desde el catálogo (professional_specialties) en la validación manual; no se
-- persiste como columna.

-- 1. Estado de validación del profesional -----------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'professional_status') then
    create type public.professional_status as enum (
      'PENDIENTE_VALIDACION_MATRICULA',
      'VALIDADO',
      'RECHAZADO',
      'SUSPENDIDO'
    );
  end if;
end$$;

-- 2. Tabla de profesionales (1:1 con profiles) ------------------------------
create table if not exists public.professionals (
  profile_id             uuid primary key references public.profiles (id) on delete cascade,
  first_name             text not null,
  last_name              text not null,
  license_number         varchar(30) not null,
  status                 public.professional_status not null default 'PENDIENTE_VALIDACION_MATRICULA',
  bio                    varchar(500),
  photo_url              text,
  consultation_price     numeric(10, 2),
  currency               char(3),
  mercadopago_account_id text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.professionals enable row level security;

-- El profesional puede leer su propia fila; escritura sólo vía service role
-- (registro por backend) o validación manual del equipo.
drop policy if exists "professionals_select_own" on public.professionals;
create policy "professionals_select_own"
  on public.professionals for select
  using (auth.uid() = profile_id);

-- 3. Trigger: crear profile (+ professional si corresponde) al alta ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role public.user_role := coalesce(
    nullif(new.raw_user_meta_data ->> 'role', '')::public.user_role,
    'PACIENTE'
  );
begin
  -- Igual que la versión original (ENG-42): crea el perfil con el rol del metadata.
  insert into public.profiles (id, email, role)
  values (new.id, new.email, v_role)
  on conflict (id) do nothing;

  -- Nuevo (ENG-43): si es profesional, crea su fila en estado pendiente.
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
$function$;

-- El trigger on_auth_user_created ya existe (ENG-42); esta migración sólo
-- redefine la función. Si no existiera, recrearlo:
--   create trigger on_auth_user_created
--     after insert on auth.users
--     for each row execute function public.handle_new_user();
