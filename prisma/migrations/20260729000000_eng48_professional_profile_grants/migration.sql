-- EP-01 · Perfil público del profesional (ENG-48) — GRANTs, políticas RLS y bucket de fotos
--
-- Los endpoints de ENG-48 no hablan con la base por Prisma: usan PostgREST con el
-- JWT del profesional (rol `authenticated`) o con la anon key (rol `anon`). Sin
-- GRANT, esas tablas devuelven `42501 permission denied` ANTES de que RLS evalúe;
-- y con RLS activa y cero políticas, toda fila queda invisible. Por eso los 4
-- endpoints devolvían 500 contra la base real (review de #19), con el código
-- correcto: faltaba el esquema, no la lógica.
--
-- ENG-43 concedió deliberadamente solo SELECT sobre `professionals` ("el alta la
-- hace el trigger SECURITY DEFINER y la escritura administrativa el service_role").
-- ENG-48 cambia esa decisión SOLO para el perfil público propio, y acotada por
-- columna — ver el bloque 1, que es el punto sensible de esta migración.
--
-- Sobre `service_role`: NO recibe GRANT acá porque el backend no lo usa para estas
-- tablas — `SupabaseService.getClient()` se construye con la ANON key, no con
-- SUPABASE_SERVICE_ROLE_KEY. Si alguna vez se cambia, hay que concederle SELECT
-- explícitamente: hoy `service_role` no tiene NINGÚN privilegio de lectura sobre
-- estas tres tablas (las crea Prisma como `postgres` y el ALTER DEFAULT PRIVILEGES
-- del schema `public` solo da TRUNCATE/REFERENCES/TRIGGER/MAINTAIN). El síntoma
-- sería idéntico al que arregla esta migración y cuesta reconocerlo.
--
-- Todo idempotente: los GRANT son acumulativos y cada política se recrea con
-- `drop policy if exists`.

-- ---------------------------------------------------------------------------
-- 1) professionals — escritura del perfil público propio, ACOTADA POR COLUMNA
-- ---------------------------------------------------------------------------
-- El GRANT es por columna a propósito. Un `grant update` a nivel tabla dejaría que
-- un profesional se ponga `status = 'VALIDADO'` por su cuenta, salteando la
-- validación manual de matrícula (y que se edite `license_number` o
-- `mercadopago_account_id`). La política RLS no alcanza para eso: acota QUÉ FILA
-- se puede tocar, no QUÉ COLUMNAS.
--
-- `currency` queda afuera deliberadamente: es CHAR(3) NOT NULL DEFAULT 'ARS', el
-- MVP es solo Argentina y el DTO no la expone. Si algún día se aceptan otras
-- monedas, hay que agregarla acá.
grant update (bio, photo_url, consultation_price, updated_at)
  on public.professionals to authenticated;

-- `professionals` ya tiene RLS (ENG-43) + FORCE (20260710000000_force_rls) y la
-- política de lectura `professionals_select_own`, que es la que además habilita el
-- WHERE del UPDATE.
drop policy if exists professionals_update_own on public.professionals;
create policy professionals_update_own on public.professionals
  for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2) specialties — catálogo público de solo lectura
-- ---------------------------------------------------------------------------
-- Fuente única del selector del perfil (ENG-48) y del filtro del catálogo público
-- (ENG-49). No tiene PII y `GET /specialties` es público (sale por la anon key,
-- sin sesión), de ahí `using (true)` y el GRANT también a `anon`.
--
-- No se concede escritura a nadie: el catálogo se cura por PR en `prisma/seed.ts`
-- y se carga con `pnpm run db:seed` (ENG-96).
grant select on public.specialties to anon, authenticated;

-- DERIVA: en Supabase estas dos tablas ya tienen `rls = true`, pero NINGUNA
-- migración lo hacía — se activó a mano desde el dashboard. O sea que el Postgres
-- local las tiene SIN RLS y Supabase CON RLS: exactamente la clase de diferencia
-- que hizo que este bug no se viera en local. Se versiona acá para que los dos
-- entornos coincidan. Es idempotente y no cambia nada en Supabase.
--
-- Sin FORCE, a diferencia de las tablas con PII (20260710000000_force_rls): el
-- owner tiene que seguir bypasseando RLS para que `pnpm run db:seed` pueda cargar
-- el catálogo por Prisma, que conecta como `postgres` y no tiene (ni debe tener)
-- política de escritura.
alter table public.specialties enable row level security;

drop policy if exists specialties_select_all on public.specialties;
create policy specialties_select_all on public.specialties
  for select
  using (true);

-- ---------------------------------------------------------------------------
-- 3) professional_specialties — cada profesional gestiona las suyas
-- ---------------------------------------------------------------------------
-- El PATCH reemplaza el set completo (delete + insert), de ahí los tres GRANT. No
-- se concede UPDATE: la fila es solo el par (professional_id, specialty_id), no hay
-- nada que actualizar en una existente.
--
-- Solo `authenticated`: el catálogo público (ENG-49) va a necesitar que `anon` lea
-- las especialidades de CUALQUIER profesional, pero eso es una decisión de ese
-- ticket (implica exponer qué profesional tiene qué especialidad sin sesión), no de
-- este. Acá el alcance es el perfil propio.
grant select, insert, delete on public.professional_specialties to authenticated;

-- Misma deriva que en `specialties` (ver arriba): activada a mano en Supabase, sin
-- versionar. Tampoco va FORCE, para no romper escrituras administrativas por Prisma.
alter table public.professional_specialties enable row level security;

drop policy if exists pro_specialties_select_own on public.professional_specialties;
create policy pro_specialties_select_own on public.professional_specialties
  for select to authenticated
  using (professional_id = auth.uid());

drop policy if exists pro_specialties_insert_own on public.professional_specialties;
create policy pro_specialties_insert_own on public.professional_specialties
  for insert to authenticated
  with check (professional_id = auth.uid());

drop policy if exists pro_specialties_delete_own on public.professional_specialties;
create policy pro_specialties_delete_own on public.professional_specialties
  for delete to authenticated
  using (professional_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4) Bucket `professional-photos` + políticas de storage
-- ---------------------------------------------------------------------------
-- Movido desde supabase/migrations/20260726000000_professional_photos_bucket.sql:
-- ese directorio no lo aplica NADA — ni CI ni el deploy; lo único automatizado es
-- `prisma migrate deploy` (ENG-96/#24 lo deja como Pre-Deploy Command en Render,
-- junto al seed). Por eso el bucket nunca se creaba y `POST /professionals/me/photo`
-- no tenía dónde escribir.
--
-- El schema `storage` lo provee Supabase y NO existe en el Postgres local del
-- docker-compose: `db/bootstrap/00_supabase_local.sql` solo emula `auth`. Por eso
-- el bloque se saltea cuando falta, y `prisma migrate deploy` sigue funcionando en
-- local, en el devcontainer y en la suite de integración. El DDL va por `execute`
-- para que ni se parsee cuando el schema no está.
do $do$
begin
  if to_regclass('storage.objects') is null then
    raise notice
      'ENG-48: schema "storage" ausente (Postgres local) — se saltea el bucket de fotos';
    return;
  end if;

  -- Bucket público, con tope de tamaño y tipos permitidos (defensa en profundidad:
  -- el backend también valida). Público porque las fotos se muestran en el catálogo
  -- a cualquier paciente, incluso sin sesión.
  execute $sql$
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
          allowed_mime_types = excluded.allowed_mime_types
  $sql$;

  -- Escritura acotada a la carpeta propia: el primer segmento de la ruta
  -- (`<uid>/avatar.ext`) tiene que ser el auth.uid() del que sube.
  execute 'drop policy if exists "own professional photo insert" on storage.objects';
  execute $sql$
    create policy "own professional photo insert"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'professional-photos'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
  $sql$;

  -- UPDATE hace falta porque la subida usa `upsert: true` (ruta fija por usuario,
  -- una sola foto vigente): si el objeto ya existe, Storage actualiza en vez de
  -- insertar.
  execute 'drop policy if exists "own professional photo update" on storage.objects';
  execute $sql$
    create policy "own professional photo update"
      on storage.objects for update to authenticated
      using (
        bucket_id = 'professional-photos'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
      with check (
        bucket_id = 'professional-photos'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
  $sql$;

  execute 'drop policy if exists "own professional photo delete" on storage.objects';
  execute $sql$
    create policy "own professional photo delete"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'professional-photos'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
  $sql$;
end
$do$;
