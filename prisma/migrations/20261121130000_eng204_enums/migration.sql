-- EP-03 · El profesional cancela un turno (ENG-204, ADR-018)
--
-- Solo los tipos. Los valores nuevos de un enum no se pueden usar en la misma
-- transacción en que se agregan (Postgres), así que las columnas, el CHECK y el
-- índice que los usan van en la migración siguiente
-- (`20261121130100_eng204_professional_cancellation`).

-- `A_REPROGRAMAR`: turno pagado que el profesional canceló. El horario queda
-- libre (no entra en el índice parcial de horarios ocupados) y el paciente
-- elige otro horario o el reembolso del 100 %.
-- AlterEnum
ALTER TYPE "appointment_status" ADD VALUE 'A_REPROGRAMAR';

-- Quién canceló el turno (ADR-018, caso 10).
-- CreateEnum
CREATE TYPE "appointment_cancelled_by" AS ENUM ('PACIENTE', 'PROFESIONAL', 'SISTEMA');

-- Avisos al paciente. No reusan `TURNO_CANCELADO` (el aviso al profesional de
-- que el paciente canceló) porque `notifications` admite un aviso por
-- (turno, tipo, canal), igual que `PAGO_ACREDITADO` en ENG-199.
-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'TURNO_CANCELADO_PROFESIONAL';
-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'REEMBOLSO_TOTAL';
