-- ENG-48 — Bucket de fotos de perfil de profesionales
--
-- Crea el bucket público `professional-photos` y las políticas RLS sobre
-- storage.objects para que cada profesional gestione SOLO los archivos dentro
-- de su propia carpeta (prefijo = su auth.uid()). La lectura es pública (el
-- bucket es public) porque las fotos se muestran en el catálogo a cualquier
-- paciente. Todo idempotente.

-- Bucket público, con tope de tamaño y tipos permitidos (defensa en profundidad;
-- el backend también valida). ------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'professional-photos',
  'professional-photos',
  true,
  2097152, -- 2 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Escritura acotada a la carpeta propia: el primer segmento de la ruta
-- (`<uid>/avatar.ext`) debe coincidir con el auth.uid() del que sube. ---------
drop policy if exists "own professional photo insert" on storage.objects;
create policy "own professional photo insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'professional-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "own professional photo update" on storage.objects;
create policy "own professional photo update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'professional-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'professional-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "own professional photo delete" on storage.objects;
create policy "own professional photo delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'professional-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
