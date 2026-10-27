-- ENG-144 — Una sola devolución por pago no aplicado (review de backend#82).
--
-- `CancellationRefundService.refundUnappliedPayment` busca la fila y, si no
-- está, la crea. Eso no es atómico: dos entregas concurrentes de la misma
-- notificación de MercadoPago podían crear dos filas `refunds` para la misma
-- devolución (MercadoPago no devuelve dos veces por la clave de idempotencia,
-- pero la contabilidad sí quedaba duplicada). Con este índice el segundo
-- `create` choca (`P2002`) y el servicio lo trata como fila existente.
--
-- Es parcial: solo los motivos `PAGO_DUPLICADO:<id>` y
-- `PAGO_SOBRE_TURNO_INACTIVO:<id>`, que llevan el id del pago de MercadoPago.
-- `CANCELACION_PACIENTE` (ENG-65) no entra. Prisma no modela índices parciales,
-- así que vive solo acá (ver el comentario en `model Refund`).
--;;
CREATE UNIQUE INDEX IF NOT EXISTS refunds_payment_reason_uq
  ON "refunds" (payment_id, reason)
  WHERE reason LIKE 'PAGO\_%';
