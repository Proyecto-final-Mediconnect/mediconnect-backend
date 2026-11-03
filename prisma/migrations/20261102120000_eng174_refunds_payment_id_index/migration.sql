-- ENG-174 — Índice en `refunds.payment_id`.
--
-- El estado del reembolso de un turno se lee por pago al listar "Mis turnos".
-- El único índice que cubría `payment_id` era el parcial de ENG-144, que solo
-- aplica a los motivos `PAGO_%`; las consultas por cancelación hacían scan.
-- (`payments.appointment_id` ya tiene su índice único.)
CREATE INDEX IF NOT EXISTS "refunds_payment_id_idx" ON "refunds"("payment_id");
