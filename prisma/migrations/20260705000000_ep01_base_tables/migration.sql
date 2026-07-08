-- EP-01 · Identidad y Acceso — Tablas base (profiles, patients, professionals)
--
-- Esta migración crea las tablas de EP-01 que hasta ahora existían solo por
-- `prisma db push` (sin historial). Va ANTES de `20260706000000_ep01_identity_rls`
-- porque esa migración habilita RLS/trigger sobre `profiles` y `patients`, que
-- deben existir primero.
--
-- IDEMPOTENTE a propósito (mismo criterio que la migración de RLS): permite
-- reconciliar una base que ya tenía `profiles`/`patients`/`user_role` creados a
-- mano o por `db push`, creando únicamente lo que falte (p. ej. `professionals`).
-- En una base vacía (Postgres local del docker-compose) crea todo desde cero.
--
-- Nota Supabase: en producción `profiles.id` es además FK → `auth.users.id`. Esa
-- FK vive fuera del modelo Prisma (schema `auth`) y no se declara acá para no
-- introducir drift; la consistencia la garantiza el trigger `handle_new_user`.

CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "user_role" AS ENUM ('PACIENTE', 'PROFESIONAL', 'MODERADOR');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "professional_status" AS ENUM ('PENDIENTE_VALIDACION_MATRICULA', 'ACTIVO', 'SUSPENDIDO');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "profiles" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "user_role" NOT NULL,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "patients" (
    "profile_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "birth_date" DATE,
    "dni" VARCHAR(15),
    "phone" TEXT,
    "address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("profile_id")
);

CREATE TABLE IF NOT EXISTS "professionals" (
    "profile_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "license_number" VARCHAR(30) NOT NULL,
    "bio" VARCHAR(500),
    "photo_url" TEXT,
    "consultation_price" DECIMAL(10,2),
    "currency" CHAR(3) NOT NULL DEFAULT 'ARS',
    "status" "professional_status" NOT NULL DEFAULT 'PENDIENTE_VALIDACION_MATRICULA',
    "mercadopago_account_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "professionals_pkey" PRIMARY KEY ("profile_id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_email_key" ON "profiles"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "patients_dni_key" ON "patients"("dni");
CREATE INDEX IF NOT EXISTS "professionals_status_idx" ON "professionals"("status");

-- CheckConstraint: precio de consulta no negativo (esquema.md · professionals)
DO $$ BEGIN
  ALTER TABLE "professionals"
    ADD CONSTRAINT "professionals_consultation_price_check" CHECK ("consultation_price" >= 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "patients"
    ADD CONSTRAINT "patients_profile_id_fkey" FOREIGN KEY ("profile_id")
    REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "professionals"
    ADD CONSTRAINT "professionals_profile_id_fkey" FOREIGN KEY ("profile_id")
    REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
