-- ENG-144 — Un solo reembolso por pago de MercadoPago que no se aplicó.
--
-- Dos entregas concurrentes de la misma notificación (MercadoPago las reenvía y
-- a veces llegan en paralelo) podían pasar el `findFirst` antes de que la otra
-- creara su fila y dejar dos `refunds` por el mismo reembolso. MercadoPago no
-- devuelve dos veces (la clave de idempotencia es fija), pero la contabilidad sí
-- quedaba duplicada.
--
-- Índice parcial: solo los motivos de ENG-144 (`PAGO_DUPLICADO:<id>`,
-- `PAGO_SOBRE_TURNO_INACTIVO:<id>`), que llevan el id del pago de MercadoPago.
-- Los reembolsos por cancelación (`CANCELACION_PACIENTE`) pueden repetirse sobre
-- un mismo pago (varios parciales) y quedan afuera. Prisma no modela índices
-- parciales: no figura en `schema.prisma`.
CREATE UNIQUE INDEX IF NOT EXISTS "refunds_payment_reason_uq"
  ON "refunds" ("payment_id", "reason")
  WHERE "reason" LIKE 'PAGO\_%';
