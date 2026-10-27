-- ENG-66 — Reprogramar un turno.
--
-- `rescheduled_at`: cuándo se movió el turno de horario. Un turno se reprograma
-- una sola vez; con la columna en NULL todavía se puede.
--
-- `TURNO_REPROGRAMADO`: el aviso in-app al profesional, igual que
-- `TURNO_CANCELADO` (ENG-69). Es el SQL que genera Prisma para el valor nuevo
-- del enum.
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "rescheduled_at" TIMESTAMPTZ(6);

ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'TURNO_REPROGRAMADO';
