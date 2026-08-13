-- ENG-49 — Índices del catálogo público de profesionales.
--
-- El listado (GET /catalog/professionals) siempre filtra por
-- status = 'VALIDADO' y pagina con ORDER BY apellido, nombre, id. Sin un
-- índice que cubra ese orden, cada página del scroll infinito obliga a
-- ordenar todos los profesionales validados y descartar el OFFSET.
--
-- CONCURRENTLY no se usa a propósito: `prisma migrate deploy` corre las
-- sentencias dentro de una transacción y CREATE INDEX CONCURRENTLY no puede
-- ejecutarse en una. Las tablas son chicas hoy (< 10 filas en Supabase), así
-- que el lock de escritura es despreciable.

create index if not exists "professionals_status_last_name_first_name_profile_id_idx"
  on public.professionals (status, last_name, first_name, profile_id);

create index if not exists "professionals_status_consultation_price_idx"
  on public.professionals (status, consultation_price);

-- El filtro por especialidad recorre la junction al revés que su PK
-- (specialty_id → profesionales), que sin este índice es un seq scan.
create index if not exists "professional_specialties_specialty_id_idx"
  on public.professional_specialties (specialty_id);
