-- EP-08 · Archivos en el chat (ENG-102)
--
-- Un mensaje puede llevar un archivo: una foto, un estudio en PDF, una receta.
--
-- `messages.attachment_url` existe desde el esquema inicial y nunca se usó. Se
-- reusa para guardar la **ruta en Storage**, no una URL: el bucket es privado y
-- las URLs se firman al pedirlas, por cinco minutos. Se suman el tipo y el
-- tamaño, que la pantalla necesita para dibujar el mensaje sin abrir el
-- archivo.
--
-- Las líneas `--;;` marcan el corte entre sentencias para que el spec de
-- integración pueda cargar el archivo statement por statement.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "attachment_mime" TEXT;
--;;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "attachment_size" INTEGER;
--;;
-- Las tres columnas del adjunto van juntas: o están las tres o ninguna. Un
-- mensaje sin texto tiene que tener archivo, y uno sin archivo, texto.
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_attachment_check";
--;;
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachment_check" CHECK (
  ("attachment_url" IS NULL) = ("attachment_mime" IS NULL)
  AND ("attachment_url" IS NULL) = ("attachment_size" IS NULL)
  AND ("attachment_url" IS NOT NULL OR coalesce(length(btrim("content")), 0) > 0)
  AND ("attachment_mime" IS NULL OR "attachment_mime" IN ('application/pdf', 'image/jpeg', 'image/png'))
  AND ("attachment_size" IS NULL OR "attachment_size" BETWEEN 1 AND 10485760)
) NOT VALID;
--;;
-- `NOT VALID` + `VALIDATE` por separado: valida las filas que ya existen sin
-- tomar un lock exclusivo largo sobre una tabla que Realtime está leyendo.
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_attachment_check";
--;;

-- ---------------------------------------------------------------------------
-- Bucket privado `chat-attachments`
-- ---------------------------------------------------------------------------
-- Las rutas son `<conversation_id>/<uuid>.<ext>`: la carpeta es la conversación,
-- que es lo que mira la política.
--
-- Subir: nadie desde el cliente, solo el backend con service role (firma de
-- archivo, rate limit y fila en `messages`). Leer —y por lo tanto firmar una
-- URL—: solo los dos participantes de esa conversación, con su propio token.
-- Es la misma regla que `messages_select_participants`: quien puede leer el
-- mensaje puede abrir su archivo, y nadie más. Sin UPDATE ni DELETE: un archivo
-- mandado no se reemplaza, igual que un mensaje.
--
-- Como en ENG-164, el schema `storage` no existe en el Postgres local: el bloque
-- se saltea y el DDL va por `execute` para que ni se parsee.
do $do$
begin
  if to_regclass('storage.objects') is null then
    raise notice
      'ENG-102: schema "storage" ausente (Postgres local) — se saltea el bucket del chat';
    return;
  end if;

  execute $sql$
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'chat-attachments',
      'chat-attachments',
      false,
      10485760, -- 10 MB
      array['application/pdf', 'image/jpeg', 'image/png']
    )
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types
  $sql$;

  execute 'drop policy if exists "chat attachment select" on storage.objects';
  execute $sql$
    create policy "chat attachment select"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'chat-attachments'
        and exists (
          select 1
          from public.conversations c
          where c.id::text = (storage.foldername(name))[1]
            and (c.patient_id = (select auth.uid()) or c.professional_id = (select auth.uid()))
        )
      )
  $sql$;
end
$do$;
