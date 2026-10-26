-- ENG-70: asegurar `conversations` y `messages` antes de ponerlas en uso, y
-- publicar `messages` en Supabase Realtime.
--
-- Las dos tablas existen desde el esquema inicial (EP-02/EP-10) sin RLS ni
-- GRANT. Hasta ahora ninguna ruta las tocaba; con el chat, la web se suscribe a
-- `messages` por Realtime con su propio JWT, y Realtime le entrega a cada
-- suscriptor solo las filas que RLS le deja leer. Es el mecanismo que validó el
-- spike ENG-52 (`prisma/spikes/eng52_realtime_chat.sql`): estas políticas son
-- las del prototipo, adaptadas a la forma real de las tablas (paciente y
-- profesional en vez de `participant_a` / `participant_b`).
--
-- **Solo lectura para el cliente.** Escribir (abrir una conversación, mandar un
-- mensaje, marcar leído) pasa por el backend, que conecta con el rol dueño de
-- las tablas (RLS no se le aplica) y valida que haya un turno entre las dos
-- personas. Por eso `authenticated` recibe `select` y nada más, y `anon` nada.
--
-- El `filter` de la suscripción no es un control de acceso, lo elige el
-- cliente: quien filtra es esta política (ver el informe del spike).
--
-- Cuando entre ENG-138 (backend sin BYPASSRLS), el rol de aplicación va a
-- necesitar GRANT de escritura sobre las dos tablas. Mismo pendiente que la
-- migración de ENG-72/ENG-73.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.conversations from anon;
    revoke all on public.messages from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.conversations from authenticated;
    revoke all on public.messages from authenticated;
    grant select on public.conversations to authenticated;
    grant select on public.messages to authenticated;
  end if;
end $$;
--;;
alter table public.conversations enable row level security;
--;;
alter table public.messages enable row level security;
--;;
drop policy if exists conversations_select_participants on public.conversations;
--;;
create policy conversations_select_participants on public.conversations
  for select
  using (patient_id = auth.uid() or professional_id = auth.uid());
--;;
drop policy if exists messages_select_participants on public.messages;
--;;
-- Un mensaje se lee solo si quien pregunta es participante de SU conversación.
-- Realtime evalúa este `exists` por suscriptor y por cambio: con un índice por
-- cada columna de participante queda en un lookup por PK más un filtro.
create policy messages_select_participants on public.messages
  for select
  using (
    exists (
      select 1
        from public.conversations c
       where c.id = messages.conversation_id
         and (c.patient_id = auth.uid() or c.professional_id = auth.uid())
    )
  );
--;;
-- La bandeja del profesional busca por `professional_id`. La del paciente ya la
-- cubre el único `(patient_id, professional_id)`.
create index if not exists "conversations_professional_id_idx"
  on public.conversations ("professional_id");
--;;
-- Realtime solo emite cambios de las tablas que están en `supabase_realtime`.
-- Va acá y no a mano desde el dashboard, para que producción no dependa de un
-- paso que alguien se olvide (recomendación 3 del spike).
--
-- El guard es para el Postgres del docker-compose y el de CI, donde Supabase no
-- existe y la publicación tampoco: ahí no hay Realtime, y crearla no serviría
-- de nada.
--
-- Sin `replica identity full`: el cliente solo escucha INSERT. Los UPDATE de
-- `read_at` no se escuchan (la lectura se marca en bloque por HTTP), así que no
-- hace falta inflar el WAL con la fila entera en cada cambio.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
         from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'messages'
     ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
