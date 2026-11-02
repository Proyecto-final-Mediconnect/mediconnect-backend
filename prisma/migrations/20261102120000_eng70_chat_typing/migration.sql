-- ENG-70: quién puede escuchar y mandar el "está escribiendo…" del chat.
--
-- El aviso de que la otra persona está escribiendo no pasa por la base ni por
-- el backend: cada navegador lo manda por un canal Broadcast de Supabase
-- Realtime, `typing:<conversation_id>`. Al no ser una fila de `messages`, la RLS
-- de esa tabla no lo cubre, y un canal público lo podría escuchar (o mandar)
-- cualquiera que conozca el id de la conversación.
--
-- Por eso el canal es **privado**: Realtime deja unirse, recibir y mandar solo
-- si estas políticas sobre `realtime.messages` lo permiten, evaluadas con el JWT
-- del usuario. Las dos piden lo mismo que la RLS del chat: ser el paciente o el
-- profesional de esa conversación.
--
-- `realtime.messages` y `realtime.topic()` son de Supabase: el guard es para el
-- Postgres del docker-compose y el de CI, donde no existen.

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists chat_typing_receive on realtime.messages';
    execute $policy$
      create policy chat_typing_receive on realtime.messages
        for select to authenticated
        using (
          extension = 'broadcast'
          and exists (
            select 1
              from public.conversations c
             where 'typing:' || c.id::text = (select realtime.topic())
               and (c.patient_id = (select auth.uid())
                 or c.professional_id = (select auth.uid()))
          )
        )
    $policy$;

    execute 'drop policy if exists chat_typing_send on realtime.messages';
    execute $policy$
      create policy chat_typing_send on realtime.messages
        for insert to authenticated
        with check (
          extension = 'broadcast'
          and exists (
            select 1
              from public.conversations c
             where 'typing:' || c.id::text = (select realtime.topic())
               and (c.patient_id = (select auth.uid())
                 or c.professional_id = (select auth.uid()))
          )
        )
    $policy$;
  end if;
end $$;
