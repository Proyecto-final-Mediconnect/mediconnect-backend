-- ENG-216 — Claves de datos por paciente para el cifrado de la HC (ADR-020, punto 8).
--
-- Solo agrega una tabla: no toca ninguna fila existente. Las entradas de la
-- historia clínica que ya están guardadas siguen en claro (versión de cifrado 0):
-- reescribirlas violaría la regla append-only, y el backend las sigue leyendo.
--
-- Cada fila es la DEK de un paciente ENVUELTA con la clave maestra `kid`. La
-- clave maestra no está en la base: vive en la variable de entorno
-- `DATA_ENCRYPTION_KEYS` del backend y del job de integridad.

CREATE TABLE "patient_data_keys" (
    "patient_id"  UUID NOT NULL,
    "kid"         TEXT NOT NULL,
    "wrapped_dek" TEXT NOT NULL,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "rotated_at"  TIMESTAMPTZ(6),

    CONSTRAINT "patient_data_keys_pkey" PRIMARY KEY ("patient_id")
);

CREATE INDEX "patient_data_keys_kid_idx" ON "patient_data_keys"("kid");

ALTER TABLE "patient_data_keys"
  ADD CONSTRAINT "patient_data_keys_patient_id_fkey"
  FOREIGN KEY ("patient_id") REFERENCES "patients"("profile_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- El formato lo arma la aplicación; el CHECK evita que un error deje una fila
-- que después ningún proceso pueda abrir.
ALTER TABLE "patient_data_keys"
  ADD CONSTRAINT "patient_data_keys_format" CHECK (
    kid ~ '^[a-z0-9-]{1,16}$' AND
    wrapped_dek ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  );

-- Nadie fuera del backend: ni `anon` ni `authenticated` (mismo patrón que
-- `integrity_checks`, ENG-85). Guardado por existencia de rol para que un
-- Postgres sin los roles de Supabase (CI) no aborte la migración.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.patient_data_keys FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.patient_data_keys FROM authenticated;
  END IF;
END $$;

-- RLS activa y cero políticas: deny-by-default para todo rol que no sea el
-- owner. Sin FORCE, porque el owner es el backend, que la usa por Prisma.
ALTER TABLE public.patient_data_keys ENABLE ROW LEVEL SECURITY;
