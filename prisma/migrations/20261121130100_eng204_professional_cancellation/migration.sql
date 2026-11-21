-- EP-03 · El profesional cancela un turno (ENG-204, ADR-018)
--
-- Columnas, CHECK e índice que usan los valores de enum agregados en
-- `20261121130000_eng204_enums`.
--
-- Las líneas `--;;` marcan el corte entre sentencias para los tests de
-- integración, igual que en las demás migraciones.

-- AlterTable
--;;
ALTER TABLE "appointments" ADD COLUMN "cancelled_by" "appointment_cancelled_by";
--;;
ALTER TABLE "appointments" ADD COLUMN "reprogram_deadline" TIMESTAMPTZ(6);

-- Hasta ENG-204 solo el paciente podía cancelar (ENG-55): toda cancelación que ya
-- existe es suya. `LIBERADO` no es una cancelación (es la retención de 15
-- minutos que venció, ENG-101) y queda sin `cancelled_by`.
--;;
UPDATE "appointments"
   SET "cancelled_by" = 'PACIENTE'
 WHERE "status" = 'CANCELADO' AND "cancelled_by" IS NULL;

-- Un turno `A_REPROGRAMAR` siempre lo canceló el profesional y siempre tiene
-- plazo: sin plazo, el job de vencimiento nunca lo resolvería y el paciente
-- quedaría con un turno pagado sin atención ni reembolso.
--;;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_a_reprogramar_check"
  CHECK ("status" <> 'A_REPROGRAMAR' OR ("cancelled_by" = 'PROFESIONAL' AND "reprogram_deadline" IS NOT NULL));

-- Lo que barre el job de vencimientos (ADR-018, caso 2): solo los turnos a
-- reprogramar, por plazo. Parcial para que no crezca con el resto de la tabla.
-- Prisma no modela índices parciales: no lo borres al regenerar el schema.
--;;
CREATE INDEX "appointments_reprogram_deadline_idx"
  ON "appointments" ("reprogram_deadline")
  WHERE "status" = 'A_REPROGRAMAR';

-- A lo sumo un reembolso total por pago (ADR-018). La salida de `A_REPROGRAMAR`
-- es un UPDATE condicional, así que corre una sola vez; este índice frena además
-- el caso en que el job retoma un reembolso que quedó a medias justo cuando el
-- request original lo estaba registrando. Mismo patrón que
-- `refunds_payment_reason_uq` (ENG-144), que solo cubre los motivos `PAGO_%`.
-- Prisma no modela índices parciales: no lo borres al regenerar el schema.
--;;
CREATE UNIQUE INDEX "refunds_payment_full_refund_uq"
  ON "refunds" ("payment_id")
  WHERE "reason" IN ('CANCELACION_PROFESIONAL', 'VENCIMIENTO_REPROGRAMACION');
