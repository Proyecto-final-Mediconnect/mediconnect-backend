-- ENG-37 — Hardening de RLS e identidad
--
-- Espeja el fix versionado en
-- prisma/migrations/20260711000000_harden_signup_role/ sobre el proyecto Supabase.
-- Dos endurecimientos, ambos idempotentes:
--
-- 1) Autoasignación de rol: `handle_new_user` leía `role` del raw_user_meta_data
--    (controlado por el cliente). Con la anon key pública, un signUp directo con
--    role=MODERADOR quedaba con perfil privilegiado. Ahora el alta solo puede
--    autoasignar PACIENTE / PROFESIONAL; cualquier otro rol se degrada a PACIENTE.
--    MODERADOR se asigna solo por service_role.
--
-- 2) FORCE RLS sobre las tablas con PII, en paridad con el lado Prisma
--    (20260710000000_force_rls): RLS pasa a aplicar también al owner. El
--    endurecimiento completo (backend con rol dedicado NO-owner, sin BYPASSRLS)
--    queda para el ticket de seguridad; un rol con BYPASSRLS/superusuario sigue
--    evitando RLS aun con FORCE. El trigger de alta (SECURITY DEFINER) sigue
--    funcionando porque corre como owner del schema.

-- 1) Alta: perfil (+ professional si corresponde) con rol acotado ------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  -- Rol pedido en el metadata del signUp (controlado por el cliente).
  v_requested public.user_role := coalesce(
    nullif(new.raw_user_meta_data ->> 'role', '')::public.user_role,
    'PACIENTE'
  );
  -- Rol efectivo: solo roles no privilegiados por autoservicio.
  v_role public.user_role := case
    when v_requested in ('PACIENTE', 'PROFESIONAL') then v_requested
    else 'PACIENTE'
  end;
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, v_role)
  on conflict (id) do nothing;

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

-- 2) FORCE RLS sobre las tablas con PII (paridad con el lado Prisma) ---------
alter table public.profiles      force row level security;
alter table public.patients      force row level security;
alter table public.professionals force row level security;
