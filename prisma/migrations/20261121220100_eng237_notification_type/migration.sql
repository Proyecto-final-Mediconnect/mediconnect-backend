-- EP-08 · Aviso al profesional de que no se conectó a una consulta (ENG-237)
--
-- Va en su propia migración: un valor nuevo de un enum no se puede usar en la
-- misma transacción en que se agrega.
-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'TURNO_NO_REALIZADO';
