-- EP-03 · Agenda semanal del profesional (ENG-53) — bloqueos por rango horario,
-- GRANTs y políticas RLS.
--
-- Igual que ENG-48, los endpoints de este ticket no hablan con la base por Prisma:
-- usan PostgREST con el JWT del profesional (rol `authenticated`). Sin GRANT, las
-- tablas devuelven `42501 permission denied` ANTES de que RLS evalúe; y con RLS
-- activa y cero políticas, toda fila queda invisible. Hoy `schedule_rules` y
-- `schedule_blocks` están exactamente así — RLS activa (se prendió a mano desde el
-- dashboard, sin versionar) y ninguna política — con lo cual los cuatro endpoints
-- de ENG-53 devolverían 500 con el código correcto. Es el mismo bug que arregló la
-- migración de ENG-48 (review de #19).
--
-- Todo idempotente: los GRANT son acumulativos, cada política se recrea con
-- `drop policy if exists` y el DDL usa `if not exists`.

-- ---------------------------------------------------------------------------
-- 1) schedule_blocks — bloquear un rango horario, no solo el día completo
-- ---------------------------------------------------------------------------
-- El criterio de aceptación pide "bloquear fechas O RANGOS HORARIOS puntuales",
-- pero la tabla solo tenía `block_date`: no había forma de expresar "el martes de
-- 14 a 16". Las dos columnas son nullables y se interpretan juntas:
--
--   start_time IS NULL AND end_time IS NULL  → el día completo (comportamiento
--                                              previo, que se conserva)
--   ambas con valor                          → solo esa franja de ese día
--
-- El CHECK impide el estado intermedio (una sola de las dos cargada), que no
-- significaría nada, y exige que el rango tenga duración positiva. Mismo criterio
-- que `schedule_rules_time_order_check`.
alter table public.schedule_blocks
  add column if not exists start_time time,
  add column if not exists end_time   time;

alter table public.schedule_blocks
  drop constraint if exists schedule_blocks_time_range_check;
alter table public.schedule_blocks
  add constraint schedule_blocks_time_range_check check (
    (start_time is null and end_time is null)
    or (start_time is not null and end_time is not null and end_time > start_time)
  );

-- `nulls not distinct` (PG 15+) es lo que hace que este índice sirva para algo en
-- el caso "día completo": con la semántica default, NULL != NULL y se podrían
-- cargar N bloqueos idénticos del mismo día entero sin que la base se queje.
--
-- Solape parcial entre franjas (14-16 y 15-17) NO lo cubre este índice; lo valida
-- el service, que ya tiene que hacerlo para `schedule_rules`.
create unique index if not exists schedule_blocks_professional_date_start_key
  on public.schedule_blocks (professional_id, block_date, start_time)
  nulls not distinct;

-- ---------------------------------------------------------------------------
-- 2) Índices por professional_id
-- ---------------------------------------------------------------------------
-- Postgres NO crea índice automáticamente por tener una FK (a diferencia de la
-- PK). Todas las consultas de agenda filtran por `professional_id`, y el `delete`
-- del reemplazo completo de reglas también.
create index if not exists schedule_rules_professional_id_idx
  on public.schedule_rules (professional_id);

create index if not exists schedule_blocks_professional_date_idx
  on public.schedule_blocks (professional_id, block_date);

-- ---------------------------------------------------------------------------
-- 3) schedule_rules — cada profesional gestiona su propia agenda
-- ---------------------------------------------------------------------------
-- Sin UPDATE, igual que `professional_specialties` en ENG-48: `PUT /schedule`
-- reemplaza el set completo de reglas (delete + insert), así que no se actualiza
-- ninguna fila existente. Si alguna vez se pasa a edición fila por fila, hay que
-- agregar el GRANT y su política.
grant select, insert, delete on public.schedule_rules to authenticated;

-- Se versiona el `enable` porque en Supabase ya está prendido a mano pero en el
-- Postgres local del docker-compose no — misma deriva que documentó ENG-48. Es
-- idempotente y no cambia nada en Supabase.
alter table public.schedule_rules enable row level security;

-- Sin FORCE, a diferencia de las tablas con PII (20260710000000_force_rls). La
-- agenda de atención no es dato clínico ni sensible, y el owner tiene que poder
-- escribirla desde Prisma para las fixtures de los tests de integración.
drop policy if exists schedule_rules_select_own on public.schedule_rules;
create policy schedule_rules_select_own on public.schedule_rules
  for select to authenticated
  using (professional_id = auth.uid());

drop policy if exists schedule_rules_insert_own on public.schedule_rules;
create policy schedule_rules_insert_own on public.schedule_rules
  for insert to authenticated
  with check (professional_id = auth.uid());

drop policy if exists schedule_rules_delete_own on public.schedule_rules;
create policy schedule_rules_delete_own on public.schedule_rules
  for delete to authenticated
  using (professional_id = auth.uid());

-- NOTA PARA ENG-54 (ver disponibilidad y reservar): un paciente va a necesitar
-- LEER las reglas y los bloqueos de OTRO profesional para que el calendario de
-- reserva muestre algo. Eso requiere ampliar el SELECT más allá del dueño, y es
-- una decisión de ese ticket — implica exponer los horarios de atención de todos
-- los profesionales. Acá el alcance es deliberadamente la agenda propia.

-- ---------------------------------------------------------------------------
-- 4) schedule_blocks — mismo criterio
-- ---------------------------------------------------------------------------
-- Sin UPDATE: los bloqueos se crean y se borran, no se editan (no hay criterio de
-- aceptación que lo pida, y "cambiar un bloqueo" es borrarlo y crear otro).
grant select, insert, delete on public.schedule_blocks to authenticated;

alter table public.schedule_blocks enable row level security;

drop policy if exists schedule_blocks_select_own on public.schedule_blocks;
create policy schedule_blocks_select_own on public.schedule_blocks
  for select to authenticated
  using (professional_id = auth.uid());

drop policy if exists schedule_blocks_insert_own on public.schedule_blocks;
create policy schedule_blocks_insert_own on public.schedule_blocks
  for insert to authenticated
  with check (professional_id = auth.uid());

drop policy if exists schedule_blocks_delete_own on public.schedule_blocks;
create policy schedule_blocks_delete_own on public.schedule_blocks
  for delete to authenticated
  using (professional_id = auth.uid());
