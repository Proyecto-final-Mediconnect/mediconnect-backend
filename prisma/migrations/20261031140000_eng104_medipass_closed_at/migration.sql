-- ENG-104: cuándo se cerró de verdad un acceso al MediPass.
--
-- El vencimiento ya se evalúa al leer (`expires_at` contra el reloj del
-- servidor), así que ninguna lectura devuelve una sesión vencida aunque este
-- job no haya corrido. `closed_at` lo deja escrito: el job lo completa con
-- `revoked_at` si el paciente la cortó, o con `expires_at` si venció sola. Es
-- el mismo patrón que la liberación de turnos sin pagar (ENG-101).
alter table public.medipass_sessions
  add column if not exists "closed_at" timestamptz(6);

-- El job busca solo las abiertas: el índice parcial queda chico aunque la
-- tabla crezca, porque cada sesión sale de él al cerrarse.
create index if not exists "medipass_sessions_open_idx"
  on public.medipass_sessions ("expires_at")
  where "closed_at" is null;
