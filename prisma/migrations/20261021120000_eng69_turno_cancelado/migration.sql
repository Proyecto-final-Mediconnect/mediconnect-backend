-- ENG-69 — Aviso in-app al profesional cuando le cancelan un turno.
--
-- `notification_type` tenía la reserva, el pago y los recordatorios, pero no la
-- cancelación. Es el SQL que genera Prisma para el valor nuevo del enum.
ALTER TYPE "notification_type" ADD VALUE 'TURNO_CANCELADO';
