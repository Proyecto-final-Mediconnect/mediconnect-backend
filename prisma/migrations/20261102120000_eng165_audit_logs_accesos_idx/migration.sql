-- ENG-165: el historial de accesos a la HC filtra audit_logs por recurso y
-- acción y ordena por fecha (más nuevo primero, `id` de desempate). Sin índice
-- es un scan de toda la bitácora, que sólo crece (append-only).
CREATE INDEX "audit_logs_resource_id_action_created_at_id_idx" ON "audit_logs"("resource_id", "action", "created_at" DESC, "id" DESC);
