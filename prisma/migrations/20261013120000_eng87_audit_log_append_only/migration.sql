-- EP-10 · Audit log inmutable de accesos a HC y MediPass (ENG-87)
--
-- `audit_logs` registra cada lectura de una historia clínica desde ENG-60, y
-- `medipass_access_logs` va a registrar cada acceso dentro de una sesión MediPass
-- (EP-09). Hasta acá las dos tablas se podían editar y borrar como cualquier
-- otra: un registro de accesos que el que accedió puede borrar no prueba nada.
--
-- Aplica a las dos el mismo esquema que ya protege `clinical_record_entries`
-- (ENG-57 + ENG-126): append-only por trigger, TRUNCATE incluido, y ningún
-- privilegio para `anon`/`authenticated`.
--
-- Las líneas `--;;` son comentarios SQL que Prisma ignora: marcan el corte entre
-- sentencias para que los tests de integración puedan cargar el archivo statement
-- por statement. Misma convención que las migraciones de ENG-57 y ENG-126.
--
-- Todo idempotente.

-- ---------------------------------------------------------------------------
-- 1) Append-only: ni UPDATE, ni DELETE, ni TRUNCATE
-- ---------------------------------------------------------------------------
-- Una sola función para las dos tablas: el mensaje lleva el nombre de la tabla
-- y la operación, así que el error dice igual qué se intentó y dónde.
--
-- `security definer` + `search_path` fijo por lo mismo que ENG-126: cuando el
-- backend pase a un rol dedicado no-owner (ENG-138), la función tiene que seguir
-- corriendo con los permisos de su dueño y sin resolver nombres contra un
-- `search_path` ajeno.
--
-- 42501 (insufficient_privilege), como en la HC, para que el backend lo distinga
-- de un fallo de conexión.
--
-- Igual que en la HC, el trigger frena al owner pero no a un superusuario, que
-- puede deshabilitarlo. Lo que este ticket cierra es el borrado "normal": un bug,
-- un script, o alguien con las credenciales del backend.
--;;
create or replace function audit_append_only_block()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception
    '% es append-only: % no permitido. Un registro de accesos no se corrige ni se borra.',
    tg_table_name,
    tg_op
    using errcode = '42501';
end;
$$;

--;;
drop trigger if exists audit_logs_no_mutation on public.audit_logs;
--;;
create trigger audit_logs_no_mutation
  before update or delete on public.audit_logs
  for each row execute function audit_append_only_block();
--;;
drop trigger if exists audit_logs_no_truncate on public.audit_logs;
--;;
-- TRUNCATE no dispara triggers de fila (ver ENG-126): sin este, un
-- `truncate profiles cascade` vaciaría el registro entero sin aviso.
create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function audit_append_only_block();

--;;
drop trigger if exists medipass_access_logs_no_mutation on public.medipass_access_logs;
--;;
create trigger medipass_access_logs_no_mutation
  before update or delete on public.medipass_access_logs
  for each row execute function audit_append_only_block();
--;;
drop trigger if exists medipass_access_logs_no_truncate on public.medipass_access_logs;
--;;
create trigger medipass_access_logs_no_truncate
  before truncate on public.medipass_access_logs
  for each statement execute function audit_append_only_block();

-- ---------------------------------------------------------------------------
-- 2) `audit_logs.actor_id`: de SET NULL a RESTRICT
-- ---------------------------------------------------------------------------
-- Con `ON DELETE SET NULL`, borrar un perfil le borraba a cada registro QUIÉN
-- accedió, que es justo lo que el registro tiene que conservar. Además, ese SET
-- NULL es un UPDATE sobre `audit_logs`, así que con el trigger de arriba el
-- borrado del perfil fallaría igual, pero con un mensaje que no explica nada.
--
-- RESTRICT lo dice de frente: un perfil con accesos auditados no se borra. Es
-- coherente con la HC, cuyas entradas ya impiden borrar al paciente y al
-- profesional (Ley 26.529, art. 18: la HC se conserva 10 años). Dar de baja a un
-- usuario (ENG-86) tiene que ser anonimizar, no borrar la fila.
--
-- Mismo nombre de constraint y misma forma que genera Prisma, para que el schema
-- y la base no difieran.
--;;
alter table public.audit_logs drop constraint if exists audit_logs_actor_id_fkey;
--;;
alter table public.audit_logs
  add constraint audit_logs_actor_id_fkey
  foreign key (actor_id) references public.profiles (id)
  on delete restrict on update restrict;

-- ---------------------------------------------------------------------------
-- 3) Nada por PostgREST
-- ---------------------------------------------------------------------------
-- Las dos tablas las escribe solo el backend, que entra por Prisma. El ALTER
-- DEFAULT PRIVILEGES de `public` les da a `anon`/`authenticated` privilegios que
-- nadie concedió —TRUNCATE entre ellos— (ver ENG-48 y ENG-85). Se revocan, y RLS
-- queda activa sin políticas: deny-by-default para todo rol que no sea el owner.
--
-- Sin FORCE: el backend escribe como owner y no hay política de INSERT. Cuando el
-- paciente pueda ver sus accesos (ENG-76), se agrega una política de SELECT.
--
-- Guardado por existencia de rol, igual que ENG-85: un Postgres pelado de CI no
-- tiene `anon`/`authenticated` y un REVOKE sobre un rol inexistente aborta la
-- cadena de migraciones.
--;;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.audit_logs from anon;
    revoke all on public.medipass_access_logs from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.audit_logs from authenticated;
    revoke all on public.medipass_access_logs from authenticated;
  end if;
end $$;
--;;
alter table public.audit_logs enable row level security;
--;;
alter table public.medipass_access_logs enable row level security;
