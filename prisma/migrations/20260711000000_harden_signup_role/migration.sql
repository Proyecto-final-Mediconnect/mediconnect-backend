-- EP-01 · Hardening — impedir autoasignación de rol privilegiado en el alta (ENG-37)
--
-- Hueco detectado en la review de ENG-37: `handle_new_user` tomaba el `role` del
-- `raw_user_meta_data`, que es CONTROLADO POR EL CLIENTE. La anon key de Supabase
-- es pública, así que alguien puede llamar a `auth.signUp` directo (salteando el
-- backend, que sí fija el rol) con `role: 'MODERADOR'` en el metadata y quedar con
-- un perfil privilegiado. El trigger `prevent_profile_role_change` solo cubre el
-- UPDATE, no el INSERT del alta → la escalada entraba por el registro.
--
-- Fix: el alta solo puede autoasignar roles NO privilegiados (PACIENTE /
-- PROFESIONAL). Cualquier otro valor válido del enum (MODERADOR, o roles que se
-- agreguen a futuro) se degrada a PACIENTE. MODERADOR queda reservado a asignación
-- administrativa (service_role), nunca por signup. Un rol fuera del enum sigue
-- fallando en el cast (fail-closed), igual que antes.
--
-- Reemplaza la versión de ENG-43 preservando su comportamiento: crea el perfil y,
-- si es PROFESIONAL, la fila en `professionals` en estado pendiente. Idempotente
-- (create or replace); en sync con
-- supabase/migrations/20260711000000_harden_signup_role.sql.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Rol pedido en el metadata del signUp (controlado por el cliente).
  v_requested public.user_role := coalesce(
    nullif(new.raw_user_meta_data ->> 'role', '')::public.user_role,
    'PACIENTE'
  );
  -- Rol efectivo: solo se aceptan roles no privilegiados por autoservicio.
  v_role public.user_role := case
    when v_requested in ('PACIENTE', 'PROFESIONAL') then v_requested
    else 'PACIENTE'
  end;
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, v_role)
  on conflict (id) do nothing;

  -- Si es profesional, crea su fila en estado pendiente de validación.
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
