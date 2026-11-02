-- EP-06 · Documentación clínica previa aportada por el paciente (ENG-164)
--
-- Estudios, epicrisis, informes y recetas que el paciente trae de otras
-- instituciones. **No son entradas de la historia clínica**: la HC la asientan
-- los profesionales y la cadena de hash (ENG-57) prueba justamente eso. Esto va
-- aparte y se muestra como "aportado por el paciente · no validado".
--
-- Las líneas `--;;` marcan el corte entre sentencias para los tests de
-- integración, igual que en las migraciones de ENG-57, ENG-126 y ENG-140.

-- CreateEnum
--;;
CREATE TYPE "patient_document_type" AS ENUM ('ESTUDIO', 'EPICRISIS', 'INFORME', 'RECETA', 'OTRO');

-- CreateTable
--;;
CREATE TABLE "patient_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "type" "patient_document_type" NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "document_date" DATE,
    "source_institution" VARCHAR(120),
    "storage_path" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "mime_type" VARCHAR(40) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ(6),

    CONSTRAINT "patient_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_documents_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760)
);

-- CreateIndex
--;;
CREATE UNIQUE INDEX "patient_documents_storage_path_key" ON "patient_documents"("storage_path");
--;;
CREATE INDEX "patient_documents_patient_id_uploaded_at_idx" ON "patient_documents"("patient_id", "uploaded_at" DESC);

-- AddForeignKey
-- RESTRICT y no CASCADE: borrar al paciente no puede borrar lo que aportó, igual
-- que la HC y `audit_logs`.
--;;
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("profile_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Append-only, con una sola excepción: retirarlo
-- ---------------------------------------------------------------------------
-- Un documento aportado no se edita ni se borra: un profesional pudo haberlo
-- visto y decidido algo con él. "Retirarlo" lo marca con `withdrawn_at` una sola
-- vez y no toca nada más; deja de mostrarse pero queda registrado. Mismo
-- esquema que el resto de las tablas sensibles: trigger por fila para UPDATE y
-- DELETE, por statement para TRUNCATE, 42501, `security definer` con
-- `search_path` fijo.
--;;
create or replace function patient_documents_block_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and old.withdrawn_at is null
     and new.withdrawn_at is not null
     and (to_jsonb(new) - 'withdrawn_at') = (to_jsonb(old) - 'withdrawn_at') then
    return new;
  end if;
  raise exception
    'patient_documents es append-only: % no permitido. Un documento solo se puede retirar, una vez.',
    tg_op
    using errcode = '42501';
end;
$$;
--;;
drop trigger if exists patient_documents_no_mutation on public.patient_documents;
--;;
create trigger patient_documents_no_mutation
  before update or delete on public.patient_documents
  for each row execute function patient_documents_block_mutation();
--;;
drop trigger if exists patient_documents_no_truncate on public.patient_documents;
--;;
create trigger patient_documents_no_truncate
  before truncate on public.patient_documents
  for each statement execute function patient_documents_block_mutation();

-- ---------------------------------------------------------------------------
-- Nada por PostgREST
-- ---------------------------------------------------------------------------
-- La escribe y la lee solo el backend, por Prisma, que es quien decide quién
-- puede ver los documentos de quién (las mismas reglas que la HC). RLS activa
-- sin políticas, como `legal_acceptances`.
--;;
alter table public.patient_documents enable row level security;
--;;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.patient_documents from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.patient_documents from authenticated;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Bucket privado `patient-documents` + políticas de storage
-- ---------------------------------------------------------------------------
-- Privado: nada se lee por URL pública, solo con URLs firmadas de pocos minutos
-- que arma el backend con el token de quien pide (Sprint 0 §5.3.1).
--
-- Las rutas son `<patient_id>/<uuid>.<ext>`. Subir solo a la carpeta propia.
-- Leer (y por lo tanto firmar una URL): el propio paciente, o un profesional
-- con la misma relación que habilita leer su HC —un turno que implique consulta
-- o haber firmado una entrada de su historia—, espejando
-- `clinical_record_entries_select_assigned_professional` (ENG-60) y el segundo
-- camino de `assertCanReadFor`. Sin UPDATE ni DELETE: un archivo aportado no se
-- reemplaza ni se borra.
--
-- Como en ENG-48, el schema `storage` no existe en el Postgres local: el bloque
-- se saltea y el DDL va por `execute` para que ni se parsee.
--;;
do $do$
begin
  if to_regclass('storage.objects') is null then
    raise notice
      'ENG-164: schema "storage" ausente (Postgres local) — se saltea el bucket de documentos';
    return;
  end if;

  execute $sql$
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'patient-documents',
      'patient-documents',
      false,
      10485760, -- 10 MB
      array['application/pdf', 'image/jpeg', 'image/png']
    )
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types
  $sql$;

  execute 'drop policy if exists "own patient document insert" on storage.objects';
  execute $sql$
    create policy "own patient document insert"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'patient-documents'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
  $sql$;

  execute 'drop policy if exists "patient document select" on storage.objects';
  execute $sql$
    create policy "patient document select"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'patient-documents'
        and (
          (storage.foldername(name))[1] = auth.uid()::text
          or exists (
            select 1
            from public.appointments a
            where a.patient_id::text = (storage.foldername(name))[1]
              and a.professional_id = auth.uid()
              and a.status in ('RESERVADO_SIN_PAGAR', 'CONFIRMADO', 'COMPLETADO')
          )
          or exists (
            select 1
            from public.clinical_record_entries e
            where e.patient_id::text = (storage.foldername(name))[1]
              and e.professional_id = auth.uid()
          )
        )
      )
  $sql$;
end
$do$;
