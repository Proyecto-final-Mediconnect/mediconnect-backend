-- Bitácora de las tareas periódicas (ENG-228)
--
-- Cada corrida de un job de `/internal/jobs/*` deja una fila: cuándo empezó,
-- cuándo terminó, cuánto tardó, qué devolvió y, si falló, por qué. Sirve para
-- tres cosas:
--
-- 1. Probar que el scheduler corre a horario (antes, el cron de GitHub corría
--    unas 3 veces por día y nadie se enteraba).
-- 2. Dejar registrado el error de una corrida que falla.
-- 3. Que dos corridas del mismo job no se pisen: una sola fila RUNNING por job.
--
-- Las líneas `--;;` marcan el corte entre sentencias para los tests de
-- integración, igual que en las demás migraciones.

-- CreateTable
--;;
CREATE TABLE "job_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "duration_ms" INTEGER,
    "result" JSONB,
    "error" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

--;;
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_status_check" CHECK ("status" IN ('RUNNING', 'OK', 'ERROR'));

-- Una corrida terminada tiene fin y duración; una en curso, no.
--;;
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_finished_check" CHECK (("status" = 'RUNNING') = ("finished_at" IS NULL));

-- CreateIndex
--;;
CREATE INDEX "job_runs_job_started_at_idx" ON "job_runs"("job", "started_at" DESC);

-- Una sola corrida en curso por job. Si el scheduler dispara mientras la
-- anterior sigue, el INSERT choca acá y el backend la saltea sin correrla.
-- Prisma no modela índices parciales: no lo borres al regenerar el schema.
--;;
CREATE UNIQUE INDEX "job_runs_one_running_per_job" ON "job_runs"("job") WHERE "status" = 'RUNNING';

-- ---------------------------------------------------------------------------
-- Nada por PostgREST
-- ---------------------------------------------------------------------------
-- La lee y la escribe solo el backend, por Prisma. RLS activa sin políticas,
-- como `integrity_checks` y `notifications`.
--;;
alter table public.job_runs enable row level security;
--;;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.job_runs from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.job_runs from authenticated;
  end if;
end $$;
