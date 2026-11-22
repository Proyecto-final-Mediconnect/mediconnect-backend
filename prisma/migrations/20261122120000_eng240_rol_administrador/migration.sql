-- EP-01 · Rol administrador de la plataforma (ENG-240, ENG-220)
--
-- `MODERADOR` se creó para moderar reseñas (HU-44/45) y quedó sin uso cuando
-- la moderación se sacó (backend #130). La gestión de médicos (ENG-220) necesita
-- un rol del equipo que administre a los profesionales: se renombra el valor en
-- lugar de agregar otro, así no queda un rol muerto en el enum.

-- 1) Ninguna cuenta hereda el rol nuevo por accidente.
--
-- Las cuentas que todavía tengan MODERADOR (en prod, la de la demo vieja, con la
-- contraseña del seed) pasarían a ser administradoras con el RENAME. Antes se
-- pasan a PACIENTE, como una cuenta recién registrada, y queda en `audit_logs`.
-- El administrador se asigna después, a propósito, con `scripts/grant-admin.ts`.
--
-- `prevent_profile_role_change` bloquea cualquier cambio de rol (ENG-37). Se
-- apaga y se vuelve a prender dentro de un único `DO`: es una sola sentencia y
-- es atómica, así que si algo falla el trigger nunca queda apagado.
DO $$
BEGIN
  ALTER TABLE public.profiles DISABLE TRIGGER profiles_prevent_role_change;

  INSERT INTO public.audit_logs (actor_id, action, resource_type, resource_id, metadata)
  SELECT NULL, 'ROLE_DEMOTED', 'profiles', p.id,
         jsonb_build_object(
           'ticket', 'ENG-240',
           'origin', 'MIGRATION',
           'previousRole', 'MODERADOR',
           'newRole', 'PACIENTE'
         )
    FROM public.profiles p
   WHERE p.role = 'MODERADOR';

  UPDATE public.profiles SET role = 'PACIENTE' WHERE role = 'MODERADOR';

  ALTER TABLE public.profiles ENABLE TRIGGER profiles_prevent_role_change;
END
$$;

-- 2) El rename.
--
-- `RENAME VALUE` no toca filas ni políticas: Postgres guarda el valor del enum
-- por OID. Ninguna función compara con el literal 'MODERADOR':
-- `handle_new_user` solo acepta PACIENTE y PROFESIONAL en el alta y degrada a
-- PACIENTE cualquier otro rol pedido (20260711000000_harden_signup_role), así
-- que nadie puede registrarse como administrador.
ALTER TYPE "user_role" RENAME VALUE 'MODERADOR' TO 'ADMINISTRADOR';
