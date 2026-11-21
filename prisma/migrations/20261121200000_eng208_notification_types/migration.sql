-- EP-08 · Avisos de cada cambio en el ciclo del turno (ENG-208, ADR-018)
--
-- Solo tipos nuevos de aviso. `notifications` admite un aviso por
-- (turno, tipo, canal): cada aviso a otro destinatario o de otro evento tiene
-- su propio tipo.

-- Al paciente: se vence el plazo para elegir qué hacer con un turno que el
-- profesional canceló (caso 2).
-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'PLAZO_REPROGRAMACION_POR_VENCER';

-- Al paciente: el comprobante de su propia cancelación, con lo que se le
-- devuelve según la política.
-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'CANCELACION_CONFIRMADA';

-- Al paciente: un reembolso que había quedado pendiente se acreditó o falló
-- (caso 16, lo resuelve el job de ENG-205).
-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'REEMBOLSO_ACTUALIZADO';

-- Al profesional: un turno que canceló terminó en reembolso, porque el
-- paciente lo eligió o porque venció el plazo.
-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'TURNO_REEMBOLSADO';
