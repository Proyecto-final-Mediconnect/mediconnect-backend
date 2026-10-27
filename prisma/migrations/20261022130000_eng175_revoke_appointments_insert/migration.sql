-- ENG-175 — Cerrar el INSERT directo sobre `appointments`.
--
-- ENG-54 le dio INSERT a `authenticated` con una sola condición: que
-- `patient_id` fuera el del JWT. Las demás columnas quedaban libres, así que
-- cualquier paciente podía reservar por PostgREST, con su JWT y la anon key
-- (que es pública), un turno con:
--
--   * `status = 'CONFIRMADO'`: confirmado sin pagar, y con ENG-147 eso abre la
--     videoconsulta;
--   * `price` arbitrario: la preferencia de MercadoPago se arma con ese precio;
--   * `scheduled_at` / `duration_minutes` fuera de la agenda del profesional;
--   * `created_at` en el pasado.
--
-- Desde ENG-175 el turno lo inserta solo el backend, como owner (Prisma), con
-- todos los valores calculados en el servidor. Ni la web ni la app insertan
-- turnos directo: reservan con `POST /appointments`.
--
-- El SELECT queda: es como cada uno lee sus turnos, y la policy
-- `appointments_select_own` sigue siendo la autorización de esa lectura.
--
-- De paso se sacan TRUNCATE, REFERENCES, TRIGGER y MAINTAIN (Postgres 17), que
-- `anon` y `authenticated` tenían por los default privileges de Supabase y
-- nadie usa. PostgREST no expone TRUNCATE, pero un permiso que no hace falta es
-- uno menos que auditar. Se hace con `REVOKE ALL` + re-conceder SELECT (como
-- ENG-85/87/140), así no depende de la versión de Postgres ni de qué sumen los
-- defaults a futuro.
-- `anon` se queda sin nada: la tabla nunca se lee sin sesión.
--
-- Las líneas `--;;` marcan el corte entre sentencias para el spec de
-- integración, igual que en ENG-63.
--;;
REVOKE ALL ON public.appointments FROM authenticated;
--;;
GRANT SELECT ON public.appointments TO authenticated;
--;;
REVOKE ALL ON public.appointments FROM anon;
--;;
DROP POLICY IF EXISTS appointments_insert_own_patient ON public.appointments;
