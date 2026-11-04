-- ENG-138 (parte 1) · Rol con permisos mínimos para el backend en runtime
--
-- Hoy el backend se conecta a Supabase como `postgres`: dueño de todas las
-- tablas. Un dueño puede `ALTER TABLE ... DISABLE TRIGGER`, así que una
-- inyección SQL o un bug en una consulta cruda podría apagar los triggers que
-- hacen inalterable la historia clínica (ENG-57/126), la auditoría (ENG-87) y
-- la constancia de consentimiento (ENG-140), y después reescribirlas. La
-- garantía central del proyecto dependería de que el código nunca se equivoque.
--
-- Con este rol el backend **no es dueño de nada**: no puede desactivar
-- triggers, ni hacer DDL, ni TRUNCATE. Y sobre las tablas append-only no tiene
-- UPDATE ni DELETE: el permiso falta antes de que el trigger tenga que actuar.
--
-- ## Lo que NO hace (es la parte 2 de ENG-138)
--
-- El rol mantiene BYPASSRLS. Que RLS filtre cada consulta de Prisma por usuario
-- exige propagar la identidad a la base en cada transacción y escribir
-- políticas por rol en cada tabla: es otro ticket, mucho más grande.
--
-- ## Por qué es un script y no una migración
--
-- `CREATE ROLE` depende de los privilegios del rol que corre las migraciones,
-- y una migración que falla en producción deja trabado el pipeline de deploy
-- hasta un `prisma migrate resolve` a mano (ver el README). Además la
-- contraseña es un secreto y no puede ir en el repo. Se corre **una vez**, a
-- mano, en el SQL Editor de Supabase, siguiendo
-- `docs/security/rol-backend.md`. Es idempotente: correrlo de nuevo no rompe.
--
-- Lo verifica `test/backend-role.integration.spec.ts` contra Postgres real.

-- El rol. Sin contraseña: no puede entrar hasta que se le ponga una.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mediconnect_backend') then
    create role mediconnect_backend
      login nosuperuser nocreatedb nocreaterole noreplication bypassrls;
  else
    alter role mediconnect_backend
      login nosuperuser nocreatedb nocreaterole noreplication bypassrls;
  end if;
end $$;

grant usage on schema public to mediconnect_backend;

-- Lectura y escritura de filas en todas las tablas. Sin TRUNCATE, sin
-- REFERENCES ni TRIGGER: nada que cambie la estructura o los triggers.
grant select, insert, update, delete on all tables in schema public to mediconnect_backend;
grant usage, select on all sequences in schema public to mediconnect_backend;

-- Las tablas append-only: el backend solo inserta. El trigger ya bloquea
-- UPDATE y DELETE; esto lo bloquea antes y aunque un dueño lo desactivara.
revoke update, delete, truncate on table
  public.clinical_record_entries,
  public.audit_logs,
  public.medipass_access_logs,
  public.legal_acceptances,
  public.integrity_checks
from mediconnect_backend;

-- `patient_documents` solo admite marcar el retiro (ENG-164): UPDATE sí, borrar no.
revoke delete, truncate on table public.patient_documents from mediconnect_backend;

-- Las tablas que agreguen las migraciones futuras (las crea `postgres`) nacen
-- con los mismos permisos de filas. Si una es append-only, su migración tiene
-- que revocar UPDATE y DELETE como arriba.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to mediconnect_backend;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to mediconnect_backend;
