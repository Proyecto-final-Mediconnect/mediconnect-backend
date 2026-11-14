-- EP-04 · Confirmación del pago al paciente (ENG-199)
--
-- `PAGO_ACREDITADO` es el aviso in-app al paciente cuando el webhook confirma
-- su pago. No reusa `PAGO_CONFIRMADO` (el aviso al profesional) porque
-- `notifications` admite un solo aviso por (turno, tipo, canal).

-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'PAGO_ACREDITADO';
