-- EP-03 · El profesional no se presenta o la consulta falla (ENG-237, ADR-018
-- casos 3, 4 y 13)
--
-- Por qué un turno pasó a `A_REPROGRAMAR` cuando no fue una cancelación a mano
-- del profesional (caso 1). `NULL` es la cancelación a mano o por bloqueo.
--
-- `cancelled_by` sigue siendo `PROFESIONAL`: el ADR trata estos casos "como el
-- caso 1", y `SISTEMA` ya significa "venció el plazo para elegir" (caso 2) en el
-- job de vencimientos, en el barrido de reembolsos y en la historia del turno.
-- Que lo detectó el sistema queda en `audit_logs` (`actor_id` nulo, origen JOB).
-- CreateEnum
CREATE TYPE "appointment_reprogram_cause" AS ENUM ('AUSENCIA_PROFESIONAL', 'FALLA_TECNICA');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN "reprogram_cause" "appointment_reprogram_cause";
