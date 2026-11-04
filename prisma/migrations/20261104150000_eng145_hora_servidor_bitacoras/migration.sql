-- EP-10 · La hora de las bitácoras la pone el servidor (ENG-145)
--
-- ENG-87 dejó `audit_logs` y `medipass_access_logs` append-only: no se pueden
-- modificar ni borrar. Pero la **fecha** la elige quien inserta. El `default
-- now()` solo actúa cuando no se manda nada, así que un INSERT con
-- `created_at` de hace un mes entra tal cual y queda inmutable con esa fecha.
--
-- En una bitácora con valor probatorio (Ley 26.529) eso vacía la garantía: de
-- nada sirve que una fila no se pueda editar si se la pudo escribir con la
-- fecha que uno quiera. Lo marcó el review de backend#62.
--
-- Un trigger `BEFORE INSERT` pisa la columna con `now()` y la fecha deja de ser
-- un dato del cliente.
--
-- ## Por qué un trigger y no otra cosa
--
--   * El `default` no alcanza: solo aplica si la columna se omite, y Prisma la
--     manda explícitamente cuando el código se la pasa.
--   * `GENERATED ALWAYS AS (now())` no existe para columnas almacenadas con
--     funciones volátiles.
--   * Revocarle la columna al rol tampoco: `INSERT` en PostgreSQL se otorga por
--     tabla o por columna, y quitarle `created_at` obligaría a enumerar todas
--     las demás en cada `grant` futuro.
--
-- ## Hasta dónde llega
--
-- Lo mismo que vale para ENG-87 vale acá, y conviene no prometer de más: el
-- backend entra como **owner** de estas tablas, y un owner puede
-- `ALTER TABLE ... DISABLE TRIGGER` o reemplazar la función. Lo que este trigger
-- garantiza es que **el camino normal de la aplicación** no puede fechar una
-- entrada en el pasado, ni por bug ni por un `createMany` con datos armados. El
-- control contra quien tenga las credenciales del backend es ENG-138.
--
-- `enable always` por el mismo motivo que ENG-87: sin eso, una sesión con
-- `session_replication_role = replica` —que el rol `postgres` de Supabase puede
-- setear— saltearía el trigger.
--
-- `security definer` con `search_path` fijo, como ENG-126 y ENG-87: cuando el
-- backend pase al rol no-owner de ENG-138, la función tiene que seguir corriendo
-- con los permisos de su dueño y sin resolver nombres contra un `search_path`
-- ajeno.
--
-- Las líneas `--;;` marcan el corte entre sentencias para que el spec de
-- integración pueda cargar el archivo statement por statement. Todo idempotente.

-- ---------------------------------------------------------------------------
-- 1) `audit_logs.created_at`
-- ---------------------------------------------------------------------------
-- Una función por tabla y no una genérica: el nombre de la columna no se puede
-- parametrizar en `new.<col>` sin bajar a `jsonb`, y dos funciones de tres
-- líneas se leen mejor que una con indirección.
--;;
create or replace function public.audit_logs_stamp_server_time()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

--;;
drop trigger if exists audit_logs_stamp_server_time on public.audit_logs;
--;;
create trigger audit_logs_stamp_server_time
  before insert on public.audit_logs
  for each row
  execute function public.audit_logs_stamp_server_time();
--;;
alter table public.audit_logs
  enable always trigger audit_logs_stamp_server_time;

-- ---------------------------------------------------------------------------
-- 2) `medipass_access_logs.accessed_at`
-- ---------------------------------------------------------------------------
--;;
create or replace function public.medipass_access_logs_stamp_server_time()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  new.accessed_at := now();
  return new;
end;
$$;

--;;
drop trigger if exists medipass_access_logs_stamp_server_time
  on public.medipass_access_logs;
--;;
create trigger medipass_access_logs_stamp_server_time
  before insert on public.medipass_access_logs
  for each row
  execute function public.medipass_access_logs_stamp_server_time();
--;;
alter table public.medipass_access_logs
  enable always trigger medipass_access_logs_stamp_server_time;

-- ---------------------------------------------------------------------------
-- 3) Nota sobre el seed de demo
-- ---------------------------------------------------------------------------
-- `prisma/seed-demo.ts` siembra accesos y auditoría con fechas pasadas a
-- propósito: la pantalla de historial de accesos (ENG-76) necesita una historia
-- que mostrar, no cinco filas con la hora de la siembra.
--
-- Con estos triggers eso ya no entra, así que el seed los desactiva alrededor de
-- esos dos `createMany` y los vuelve a dejar como estaban. Es una excepción
-- explícita y acotada, hecha por el owner, en un script de demo — no un agujero
-- del camino de la aplicación, que es lo que esta migración cierra.
