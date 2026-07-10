-- Defensa en profundidad (review de ENG-37): FORCE RLS en las tablas con PII.
--
-- Por defecto, RLS NO se aplica al OWNER de la tabla (postgres, que las crea vía
-- Prisma). FORCE hace que RLS aplique también al owner, de modo que una query que
-- se olvide de adoptar el rol `authenticated` no lea/escriba datos ajenos por
-- accidente — peligroso con datos médicos.
--
-- Nota: un superusuario o un rol con BYPASSRLS sigue evitando RLS aun con FORCE.
-- El endurecimiento completo (que el backend conecte con un rol dedicado NO-owner
-- en vez de `postgres`) queda para el ticket de seguridad. El trigger de alta
-- (handle_new_user, SECURITY DEFINER como owner) sigue funcionando porque corre
-- como superusuario.
alter table public.profiles      force row level security;
alter table public.patients      force row level security;
alter table public.professionals force row level security;
