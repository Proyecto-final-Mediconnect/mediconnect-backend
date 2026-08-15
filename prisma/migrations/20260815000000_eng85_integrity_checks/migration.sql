-- EP-06 · ENG-85 (TT-03) — Verificación periódica de integridad de la cadena de hash
--
-- Tres bloques:
--   1) El fix bloqueante de `clinical_record_entries.created_at` que dejó abierto
--      el spike ENG-45. Sin esto el job reporta manipulación sobre filas sanas.
--   2) `chain_head_snapshots`: la cabeza de cada cadena al cierre de la última
--      corrida sana. Es lo único que permite detectar el truncado de la cola.
--   3) GRANTs y RLS de las dos tablas del job.
--
-- Todo idempotente.

-- ---------------------------------------------------------------------------
-- 1) clinical_record_entries.created_at -> timestamptz(3), sin default
-- ---------------------------------------------------------------------------
-- `created_at` entra a la preimagen del hash. Postgres lo guardaba con precisión
-- de microsegundos (`timestamptz(6)`) y el `Date` de JavaScript solo llega al
-- milisegundo: al releer una entrada para verificarla se perdían los micros, el
-- SHA-256 recalculado no coincidía y la verificación marcaba CONTENT_TAMPERED
-- sobre una entrada que nadie tocó. Con `default now()` el síntoma además era
-- intermitente, porque dependía de que el redondeo cayera justo.
--
-- Se saca también el DEFAULT: para sellar la entrada hay que tener el timestamp
-- exacto en memoria en el momento de calcular el hash, así que lo tiene que
-- generar la aplicación (ENG-57) y no la base.
--
-- El ALTER no pierde datos hoy —la tabla está vacía, el escritor de HC llega en
-- ENG-57— pero conviene saber que si tuviera filas, `timestamptz(6) ->
-- timestamptz(3)` REDONDEA los microsegundos y eso invalidaría los hashes ya
-- escritos. Es exactamente el motivo por el que este cambio va antes de que
-- exista la primera entrada real y no después.
ALTER TABLE "clinical_record_entries"
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "created_at" DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- 2) chain_head_snapshots — la cabeza de cada cadena, corrida a corrida
-- ---------------------------------------------------------------------------
-- Una cadena de hash no conoce su propia longitud: si se borran las últimas N
-- entradas de un paciente, las que quedan siguen contiguas, enlazadas y
-- arrancando en el génesis, y la verificación da `valid`. Guardar la cabeza de la
-- corrida anterior es lo que convierte ese borrado en detectable.
--
-- Tiene que existir DESDE LA PRIMERA CORRIDA: un snapshot que se empieza a
-- escribir después de que ya hay entradas no puede afirmar nada sobre lo que
-- pasó antes.
CREATE TABLE IF NOT EXISTS "chain_head_snapshots" (
    "patient_id" UUID NOT NULL,
    "head_hash" CHAR(64) NOT NULL,
    "sequence_number" BIGINT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_head_snapshots_pkey" PRIMARY KEY ("patient_id")
);

-- ON DELETE RESTRICT, igual que `clinical_record_entries.patient_id`: borrar un
-- paciente no puede llevarse por delante la evidencia de su cadena.
DO $$ BEGIN
  ALTER TABLE "chain_head_snapshots"
    ADD CONSTRAINT "chain_head_snapshots_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patients"("profile_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Índice para el listado del job por antigüedad de corrida.
CREATE INDEX IF NOT EXISTS "integrity_checks_run_at_idx" ON "integrity_checks"("run_at");

-- ---------------------------------------------------------------------------
-- 3) GRANTs y RLS
-- ---------------------------------------------------------------------------
-- Ninguna de estas dos tablas se expone por PostgREST: las escribe y las lee solo
-- el job, que entra por Prisma como el rol de la aplicación. `anon` y
-- `authenticated` no tienen nada que hacer acá.
--
-- El REVOKE es defensa en profundidad sobre el ALTER DEFAULT PRIVILEGES del
-- schema `public` (ver la nota de ENG-48): las tablas nuevas pueden nacer con
-- privilegios que nadie concedió explícitamente. Revocar es barato y deja el
-- estado escrito en una migración en vez de asumido.
--
-- El bloque va guardado por existencia de rol: `anon`/`authenticated` los crea
-- `db/bootstrap/00_supabase_local.sql` en el docker local y los trae Supabase en
-- prod, pero un Postgres pelado (una base nueva de CI, un entorno efímero) no los
-- tiene, y un REVOKE sobre un rol inexistente aborta toda la cadena de
-- migraciones con 42704.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.integrity_checks FROM anon;
    REVOKE ALL ON public.chain_head_snapshots FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.integrity_checks FROM authenticated;
    REVOKE ALL ON public.chain_head_snapshots FROM authenticated;
  END IF;
END $$;

-- RLS activa y CERO políticas: deny-by-default para todo rol que no sea el owner.
-- Es el mismo patrón que `specialties` (ENG-48) pero al revés — allá había una
-- política de lectura pública, acá no hay ninguna a propósito.
--
-- SIN `force`, y esto es deliberado: con FORCE la política aplicaría también al
-- owner, que es justamente el rol con el que el job escribe por Prisma, y el job
-- se quedaría sin poder registrar su propio resultado. La diferencia con las
-- tablas de PII de `20260710000000_force_rls` es que acá el owner ES el
-- destinatario legítimo de la tabla, no un accidente.
ALTER TABLE public.integrity_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chain_head_snapshots ENABLE ROW LEVEL SECURITY;
