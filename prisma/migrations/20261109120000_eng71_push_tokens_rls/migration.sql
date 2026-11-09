-- ENG-71 — Asegurar `push_tokens` antes de ponerla en uso.
--
-- La tabla existe desde el esquema inicial (EP-02/EP-10) sin RLS ni REVOKE.
-- Con el push, guarda el token Expo de cada dispositivo: quien lo tenga puede
-- mandarle notificaciones a ese celular, así que no se expone por PostgREST. La
-- escribe y la lee solo el backend por Prisma (registro, baja y limpieza de
-- tokens vencidos).
--
-- Mismo patrón que `notifications` (ENG-68) e `integrity_checks` (ENG-85):
-- REVOKE como defensa en profundidad sobre el ALTER DEFAULT PRIVILEGES del
-- schema `public`, y RLS activa sin políticas (deny-by-default para todo rol que
-- no sea el owner). El rol del backend (ENG-138) tiene BYPASSRLS y sus GRANT de
-- escritura no se tocan acá. Guardado por existencia de rol, por el Postgres
-- pelado de CI.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.push_tokens FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.push_tokens FROM authenticated;
  END IF;
END $$;

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
