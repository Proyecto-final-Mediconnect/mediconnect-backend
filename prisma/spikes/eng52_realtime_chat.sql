-- ENG-52 · Prototipo de Supabase Realtime con RLS para el chat (EP-08)
--
-- NO es una migración de Prisma, y está fuera de prisma/migrations a propósito:
-- crea TABLAS DE PRUEBA (`spike_realtime_*`), no toca `conversations` ni
-- `messages` reales y no debe correr en producción como parte de un deploy.
-- ENG-56 se lleva de acá el diseño ya validado, no este archivo.
--
-- Se pega y ejecuta a mano en el SQL editor del proyecto de Supabase, porque
-- necesita un proyecto real: Realtime no existe en el Postgres del docker-compose.
-- Después se corre `pnpm run spike:eng52`, que hace la validación empírica.
--
-- Al terminar, el teardown está al pie del archivo.
--
-- Todo idempotente: se puede correr N veces seguidas.

-- ---------------------------------------------------------------------------
-- 1) Tablas de prueba
-- ---------------------------------------------------------------------------
-- Espejan la forma de `conversations` / `messages` (dos participantes por hilo,
-- mensajes que cuelgan del hilo) sin arrastrar el resto del modelo: acá no
-- interesan adjuntos, read_at ni el par único paciente-profesional, interesa
-- quién puede LEER qué.

drop table if exists spike_realtime_messages cascade;
drop table if exists spike_realtime_conversations cascade;

create table spike_realtime_conversations (
  id            uuid primary key default gen_random_uuid(),
  participant_a uuid           not null references auth.users (id) on delete cascade,
  participant_b uuid           not null references auth.users (id) on delete cascade,
  created_at    timestamptz(3) not null default now()
);

create table spike_realtime_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid           not null references spike_realtime_conversations (id) on delete cascade,
  sender_id       uuid           not null references auth.users (id) on delete cascade,
  content         text           not null,
  created_at      timestamptz(3) not null default now()
);

create index spike_realtime_messages_conversation_created
  on spike_realtime_messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- 2) GRANTs
-- ---------------------------------------------------------------------------
-- Sin GRANT, las tablas devuelven `42501 permission denied` ANTES de que RLS
-- llegue a evaluarse, y el síntoma se confunde con "RLS me bloqueó". Es el mismo
-- detalle que documenta la migración de ENG-48.
--
-- Solo `select`: en el prototipo los mensajes los inserta la service_role desde
-- el script. Quién puede ESCRIBIR es una decisión de ENG-56 y no cambia lo que
-- este spike valida, que es quién puede LEER.

grant select on spike_realtime_conversations to authenticated;
grant select on spike_realtime_messages      to authenticated;

-- `service_role` saltea RLS pero NO saltea los GRANT de tabla: son dos capas
-- distintas y es fácil confundirlas. Sin esto, el script falla con
-- `42501 permission denied` al insertar, antes de que RLS entre en juego.
--
-- En un proyecto Supabase recién creado esto vendría del `alter default
-- privileges ... grant all on tables to service_role`; acá no aplica porque el
-- proyecto da los permisos explícitos por tabla (ver la migración de ENG-48).
grant select, insert on spike_realtime_conversations to service_role;
grant select, insert on spike_realtime_messages      to service_role;

-- ---------------------------------------------------------------------------
-- 3) RLS
-- ---------------------------------------------------------------------------
-- El punto del spike: Realtime evalúa ESTAS políticas por cada suscriptor antes
-- de entregarle un cambio. Si la política no deja leer la fila con un `select`
-- normal, tampoco llega por el WebSocket.

alter table spike_realtime_conversations enable row level security;
alter table spike_realtime_messages      enable row level security;

create policy spike_conversations_select_participants
  on spike_realtime_conversations for select to authenticated
  using (participant_a = auth.uid() or participant_b = auth.uid());

-- Un mensaje se lee solo si quien pregunta es participante de SU conversación.
-- El `exists` es la parte cara: se evalúa por suscriptor y por cambio (ver el
-- informe, sección de performance).
create policy spike_messages_select_participants
  on spike_realtime_messages for select to authenticated
  using (
    exists (
      select 1
        from spike_realtime_conversations c
       where c.id = spike_realtime_messages.conversation_id
         and (c.participant_a = auth.uid() or c.participant_b = auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- 4) Realtime
-- ---------------------------------------------------------------------------
-- Una tabla solo emite cambios si está en la publicación `supabase_realtime`.
-- En un proyecto de Supabase ya viene creada; el guard es para no fallar si
-- alguien corre esto en una base donde no existe.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

alter publication supabase_realtime add table spike_realtime_messages;

-- REPLICA IDENTITY FULL: sin esto, el WAL de un UPDATE/DELETE solo trae la PK, y
-- Realtime no tiene la fila completa contra la cual evaluar RLS ni con qué
-- llenar `old_record`. Para INSERT no haría falta, pero el chat va a necesitar
-- UPDATE (read_at) y conviene validar el modo que se va a usar de verdad.
--
-- Tiene costo: infla el WAL porque cada cambio escribe la fila entera.
alter table spike_realtime_messages replica identity full;

-- ---------------------------------------------------------------------------
-- Teardown (correr al terminar el spike)
-- ---------------------------------------------------------------------------
-- drop table if exists spike_realtime_messages cascade;
-- drop table if exists spike_realtime_conversations cascade;
--
-- Los usuarios de prueba los borra el propio script; si quedó alguno colgado por
-- un corte a mitad de camino:
-- select id, email from auth.users where email like 'eng52+%@mediconnect.test';
