-- Arregla la subida de la foto de perfil del profesional, que nunca funcionó.
--
-- Síntoma: `POST /professionals/me/photo` respondía 500 siempre, desde la
-- primera subida. Storage devolvía 403 "new row violates row-level security
-- policy", aunque las políticas de INSERT y UPDATE del bucket existen y son
-- correctas (ver 20260729000000_eng48_professional_profile_grants).
--
-- Causa: el service sube con `upsert: true` —ruta fija `<uid>/avatar.ext`, una
-- sola foto vigente por profesional—, y Supabase Storage traduce eso a un
-- `insert ... on conflict do update`. PostgreSQL exige política de **SELECT**
-- sobre la tabla destino cuando se usa `on conflict do update`: necesita poder
-- leer la fila en conflicto para decidir. La migración anterior creó INSERT,
-- UPDATE y DELETE, y esa es justamente la que falta.
--
-- Que falte SELECT no se nota con un INSERT común: por eso una subida hecha a
-- mano con POST sin `x-upsert` entra sin problema, y la del backend no. Como el
-- header va siempre, el camino de conflicto se toma aunque el objeto todavía no
-- exista, y la primera subida ya falla.
--
-- Alcance de lo que se agrega: leer las FILAS de `storage.objects` de la carpeta
-- propia. No amplía quién ve las fotos —el bucket es público y cualquiera con la
-- URL ya las descarga—, solo permite al dueño ver el registro de la suya.
--
-- El bloque se saltea si no existe el schema `storage`, por lo mismo que la
-- migración original: el Postgres local del docker-compose solo emula `auth`, y
-- `prisma migrate deploy` tiene que seguir corriendo ahí y en integración.
do $do$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'Schema "storage" ausente (Postgres local): se saltea la política.';
    return;
  end if;

  execute 'drop policy if exists "own professional photo select" on storage.objects';
  execute $sql$
    create policy "own professional photo select"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'professional-photos'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
  $sql$;
end
$do$;
