-- EP-05 · Videoconsulta desde un turno confirmado (ENG-56) — RLS de las tablas
-- que respaldan la sala.
--
-- A diferencia de ENG-47/48/53/54, acá NO se concede nada a `authenticated`, y
-- es deliberado: `consultations` y `video_sessions` no se leen ni se escriben
-- desde el navegador. El único camino es `POST /appointments/:id/video`, que
-- valida la ventana horaria, resuelve el rol y firma un meeting token de Daily.
-- Un GET directo a PostgREST sobre `video_sessions` devolvería
-- `daily_room_name` y `audio_recording_url` — el nombre de la sala de una
-- consulta médica y la URL de su grabación — sin pasar por ninguna de esas
-- validaciones.
--
-- Igual se habilita RLS en las dos. Con RLS activa y cero políticas, toda fila
-- queda invisible para `anon` y `authenticated`: es negar por defecto, no
-- olvidarse. Sin `enable row level security`, si alguien concediera un SELECT
-- más adelante (o Supabase cambiara sus defaults), las tablas quedarían
-- completamente abiertas sin que nadie lo note. El backend las escribe por
-- Prisma, que corre como owner y no está sujeto a RLS.
--
-- Sin FORCE, por el mismo criterio que `appointments` en ENG-54: el owner tiene
-- que poder leer y escribir estas filas, y las fixtures de los tests de
-- integración también. FORCE queda para las tablas con PII directa
-- (`profiles`, `patients`, `professionals` — ver 20260710000000_force_rls).
--
-- Todo idempotente.

alter table public.consultations  enable row level security;
alter table public.video_sessions enable row level security;

-- ---------------------------------------------------------------------------
-- Índice para resolver "¿ya hay sala para este turno?"
-- ---------------------------------------------------------------------------
-- `consultations_appointment_id_key` y `video_sessions_consultation_id_key` ya
-- existen desde EP-02 y son unique: son las que hacen que el get-or-create de la
-- sala sea seguro cuando el paciente y el profesional entran al mismo tiempo.
-- El segundo en llegar choca contra la unique en vez de crear una sala paralela,
-- y el service lo trata releyendo la fila del primero.
--
-- No hace falta ningún índice nuevo. Se deja anotado para que ENG-58 (entradas
-- de HC durante la consulta) no lo vuelva a averiguar.
