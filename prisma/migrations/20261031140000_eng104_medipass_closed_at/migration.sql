-- ENG-104: cuándo se cerró de verdad un acceso al MediPass.
--
-- El vencimiento ya se evalúa al leer (`expires_at` contra el reloj del
-- servidor), así que ninguna lectura devuelve una sesión vencida aunque este
-- job no haya corrido. `closed_at` lo deja escrito: el job lo completa con
-- `revoked_at` si el paciente la cortó, o con `expires_at` si venció sola. Es
-- el mismo patrón que la liberación de turnos sin pagar (ENG-101).
alter table public.medipass_sessions
  add column if not exists "closed_at" timestamptz(6);

-- El job busca solo las abiertas, con dos índices parciales (uno por condición,
-- porque el job las junta con `union` y no con `or`, que no usaría ninguno).
-- Quedan chicos aunque la tabla crezca: cada sesión sale de ellos al cerrarse.
-- Prisma no modela índices parciales, así que viven solo acá y no en
-- schema.prisma.
create index if not exists "medipass_sessions_open_idx"
  on public.medipass_sessions ("expires_at")
  where "closed_at" is null;

create index if not exists "medipass_sessions_open_revoked_idx"
  on public.medipass_sessions ("revoked_at")
  where "closed_at" is null and "revoked_at" is not null;

-- No hay backfill acá: las sesiones previas quedan con `closed_at` en null y el
-- job las cierra de a lotes (1000 por UPDATE, hasta 20 por corrida), así que
-- una tabla grande converge en varias corridas sin pasar el `--max-time 60` del
-- workflow. `closed_at` es informativo: no se usa para autorizar.
