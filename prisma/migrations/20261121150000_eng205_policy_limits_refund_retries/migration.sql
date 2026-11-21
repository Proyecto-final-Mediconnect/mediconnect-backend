-- EP-04 · Cancelación del paciente (ENG-205, ADR-018 casos 6 y 16)
--
-- Dos cosas:
--
-- 1. **Límites de plataforma para la política de cancelación:** el reembolso
--    total aplica al menos desde 24 h antes del turno, y el parcial es de al
--    menos el 30 %. Las políticas que estén fuera de rango se llevan al límite
--    (siempre a favor del paciente) y cada ajuste queda en `audit_logs`.
-- 2. **Reintento de reembolsos:** un reembolso que MercadoPago no confirmó no
--    puede quedar PENDIENTE en silencio (hallazgo de ENG-223). Se registra
--    cuántas veces se intentó, cuándo y el último error, para que el job lo
--    retome y, si no se puede, lo marque RECHAZADO con motivo.
--
-- Las líneas `--;;` marcan el corte entre sentencias para los tests de
-- integración, igual que en las demás migraciones.

-- ---------------------------------------------------------------------------
-- 1) Políticas fuera de rango → al límite, con auditoría
-- ---------------------------------------------------------------------------
--;;
WITH antes AS (
  SELECT professional_id,
         hours_full_refund      AS f,
         hours_partial_refund   AS p,
         partial_refund_percent AS pct
    FROM cancellation_policies
   WHERE hours_full_refund > 24 OR partial_refund_percent < 30
),
ajustadas AS (
  UPDATE cancellation_policies c
     SET hours_full_refund      = LEAST(c.hours_full_refund, 24),
         hours_partial_refund   = LEAST(c.hours_partial_refund, LEAST(c.hours_full_refund, 24)),
         partial_refund_percent = GREATEST(c.partial_refund_percent, 30),
         updated_at             = now()
    FROM antes a
   WHERE c.professional_id = a.professional_id
  RETURNING c.professional_id, c.hours_full_refund, c.hours_partial_refund, c.partial_refund_percent
)
INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, metadata)
SELECT NULL,
       'CANCELLATION_POLICY_ADJUSTED',
       'cancellation_policies',
       j.professional_id,
       jsonb_build_object(
         'ticket', 'ENG-205',
         'origin', 'MIGRACION',
         'antes', jsonb_build_object('hoursFullRefund', a.f, 'hoursPartialRefund', a.p, 'partialRefundPercent', a.pct),
         'despues', jsonb_build_object('hoursFullRefund', j.hours_full_refund, 'hoursPartialRefund', j.hours_partial_refund, 'partialRefundPercent', j.partial_refund_percent)
       )
  FROM ajustadas j
  JOIN antes a USING (professional_id);

-- Los límites quedan en la base: un INSERT o UPDATE que se saltee el service
-- igual no puede guardar una política abusiva.
--;;
ALTER TABLE "cancellation_policies" ADD CONSTRAINT "cancellation_policies_platform_limits_check"
  CHECK (("hours_full_refund" IS NULL OR "hours_full_refund" <= 24)
     AND ("partial_refund_percent" IS NULL OR "partial_refund_percent" >= 30));

-- ---------------------------------------------------------------------------
-- 2) Reintentos de reembolsos
-- ---------------------------------------------------------------------------
-- AlterTable
--;;
ALTER TABLE "refunds" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
--;;
ALTER TABLE "refunds" ADD COLUMN "last_attempt_at" TIMESTAMPTZ(6);
--;;
ALTER TABLE "refunds" ADD COLUMN "last_error" TEXT;

-- Lo que barre el job de reintentos: solo los pendientes.
-- Prisma no modela índices parciales: no lo borres al regenerar el schema.
--;;
CREATE INDEX "refunds_pending_created_at_idx" ON "refunds" ("created_at") WHERE "status" = 'PENDIENTE';
