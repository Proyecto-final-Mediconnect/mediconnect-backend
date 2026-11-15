-- Reseñas sin moderación: la reseña se publica (APROBADA) al crearse.
--
-- El endpoint de moderación ya no existe, así que las reseñas que quedaron en
-- PENDIENTE_MODERACION antes del deploy no se publicarían nunca (el paciente la
-- vería "pendiente" para siempre y el profesional no recibiría el rating).
-- Se publican acá. Idempotente: una segunda corrida no encuentra filas.
UPDATE "reviews"
SET "status" = 'APROBADA',
    "moderation_reason" = 'Publicada al eliminar la moderación de reseñas',
    "moderated_at" = now()
WHERE "status" = 'PENDIENTE_MODERACION';
