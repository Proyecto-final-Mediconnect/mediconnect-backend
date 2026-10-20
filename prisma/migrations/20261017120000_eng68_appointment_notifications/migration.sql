-- ENG-68 — Emails de confirmación y recordatorio de turnos.
--
-- `notifications` existe desde EP-02 pero nadie la escribía. Los emails de turno
-- la usan como registro de qué se mandó, y para eso necesita saber de QUÉ turno
-- es cada notificación.
--
-- 1) `appointment_id`: nullable, porque las notificaciones que no son de un turno
--    (mensajes, reseñas) no lo tienen. ON DELETE CASCADE: sin turno, el registro
--    de sus avisos no tiene sentido.
ALTER TABLE "notifications" ADD COLUMN "appointment_id" UUID;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_appointment_id_fkey"
  FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) Un aviso de cada tipo por turno y canal. Es lo que impide mandar dos veces
--    el mismo email: el job y el webhook pueden intentar el mismo envío a la vez,
--    y el que inserta primero es el único que manda. Postgres trata los NULL
--    como distintos, así que las notificaciones sin turno no chocan entre sí.
--    El nombre es el que genera Prisma para el `@@unique` del schema.
CREATE UNIQUE INDEX "notifications_appointment_id_type_channel_key"
  ON "notifications"("appointment_id", "type", "channel");

-- 3) La tabla no se expone por PostgREST: la escribe y la lee el backend por
--    Prisma. Mismo patrón que `integrity_checks` (ENG-85): REVOKE como defensa
--    en profundidad sobre el ALTER DEFAULT PRIVILEGES del schema `public`, y RLS
--    activa sin políticas (deny-by-default para todo rol que no sea el owner).
--    Cuando exista la bandeja in-app, esa historia agrega su política de lectura.
--    Guardado por existencia de rol, por el Postgres pelado de CI.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.notifications FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.notifications FROM authenticated;
  END IF;
END $$;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
