-- ENG-180 — Índice en `refunds.payment_id`.
--
-- Postgres no indexa las claves foráneas solas. La cancelación y el webhook de
-- pagos buscan reembolsos por pago, y el índice único parcial
-- `refunds_payment_reason_uq` (ENG-144) solo cubre los motivos `PAGO_%`, así que
-- no sirve para el resto (`CANCELACION_PACIENTE`).
CREATE INDEX IF NOT EXISTS "refunds_payment_id_idx" ON "refunds" ("payment_id");
