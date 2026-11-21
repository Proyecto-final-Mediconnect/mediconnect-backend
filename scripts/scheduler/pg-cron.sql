-- =============================================================================
-- Scheduler de las tareas periódicas con pg_cron + pg_net (ENG-228)
-- =============================================================================
--
-- Qué hace: Supabase dispara cada minuto (o cada 5) un POST a
-- `/internal/jobs/<job>` del backend, con el `JOBS_SECRET` como Bearer. Es el
-- reemplazo del cron de GitHub Actions, que en la práctica corría unas 3 veces
-- por día.
--
-- Por qué pg_cron:
--   - Corre dentro de la base, con precisión de minuto, y está incluido en el
--     plan gratis de Supabase.
--   - El secreto vive en Supabase Vault, cifrado; no queda en este archivo ni en
--     la tabla de jobs.
--   - Cada disparo queda en `cron.job_run_details` y cada respuesta HTTP en
--     `net._http_response` (6 h); cada corrida del lado del backend, en
--     `public.job_runs`.
--
-- Efecto sobre Render: un request por minuto mantiene despierto el backend
-- (Render Free duerme tras 15 minutos sin requests), así que desaparecen los
-- arranques en frío de 30-50 s en pagos y webhooks. Un servicio encendido todo el
-- mes usa como máximo 744 h, dentro de las 750 h gratis por workspace, porque la
-- web es un sitio estático y no consume horas. Si se agrega otro web service
-- gratis al workspace, revisar ese cálculo.
--
-- NO es una migración de Prisma a propósito: pg_cron y pg_net existen en
-- Supabase pero no en el Postgres pelado de los tests de integración, y la URL
-- del backend cambia por entorno. Se aplica UNA vez por entorno, a mano, desde
-- el SQL Editor de Supabase. Es idempotente: correrlo de nuevo actualiza los jobs
-- por nombre, no los duplica.
--
-- Fuente de los nombres y frecuencias: `src/jobs/jobs.config.ts`. Si cambian
-- allá, cambian acá.
--
-- -----------------------------------------------------------------------------
-- PASO PREVIO (lo hace una persona, una vez; el secreto no se commitea):
--
--   select vault.create_secret('<el JOBS_SECRET de Render>', 'mediconnect_jobs_secret');
--   select vault.create_secret('https://mediconnect-backend-smss.onrender.com', 'mediconnect_backend_url');
--
-- Si se rota el JOBS_SECRET en Render, actualizarlo también acá:
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'mediconnect_jobs_secret'),
--     '<el JOBS_SECRET nuevo>');
-- -----------------------------------------------------------------------------

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Esquema propio, fuera de `public`: PostgREST no lo expone y nadie más que el
-- dueño puede usarlo.
create schema if not exists scheduler;
revoke all on schema scheduler from public;

-- Dispara un job del backend. Lee los secretos de Vault en cada llamada, así una
-- rotación no requiere tocar los jobs.
create or replace function scheduler.trigger_job(job text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  backend_url text;
  jobs_secret text;
begin
  -- Solo nombres de job, nunca una ruta arbitraria.
  if job !~ '^[a-z]+(-[a-z]+)*$' then
    raise exception 'Nombre de job inválido: %', job;
  end if;

  select decrypted_secret into backend_url
    from vault.decrypted_secrets where name = 'mediconnect_backend_url';
  select decrypted_secret into jobs_secret
    from vault.decrypted_secrets where name = 'mediconnect_jobs_secret';
  if backend_url is null or jobs_secret is null then
    raise exception 'Faltan los secretos mediconnect_backend_url o mediconnect_jobs_secret en Vault (ver el paso previo de scripts/scheduler/pg-cron.sql).';
  end if;

  return net.http_post(
    url := backend_url || '/internal/jobs/' || job,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || jobs_secret,
      'Content-Type', 'application/json'
    ),
    -- Margen para un arranque en frío de Render si el servicio llegó a dormirse.
    timeout_milliseconds := 60000
  );
end;
$$;

revoke all on function scheduler.trigger_job(text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function scheduler.trigger_job(text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function scheduler.trigger_job(text) from authenticated;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Jobs. Los de 5 minutos van escalonados para no llegar todos juntos.
-- -----------------------------------------------------------------------------
select cron.schedule('mediconnect-release-unpaid-appointments', '* * * * *',
  $$select scheduler.trigger_job('release-unpaid-appointments')$$);
select cron.schedule('mediconnect-close-expired-medipass-sessions', '* * * * *',
  $$select scheduler.trigger_job('close-expired-medipass-sessions')$$);
-- El monitor de Sentry (SCHEDULER_MONITOR) espera este job en */5.
select cron.schedule('mediconnect-send-appointment-reminders', '*/5 * * * *',
  $$select scheduler.trigger_job('send-appointment-reminders')$$);
select cron.schedule('mediconnect-close-finished-appointments', '1-59/5 * * * *',
  $$select scheduler.trigger_job('close-finished-appointments')$$);
select cron.schedule('mediconnect-send-review-requests', '2-59/5 * * * *',
  $$select scheduler.trigger_job('send-review-requests')$$);

-- Limpieza: la bitácora no crece sin control.
select cron.schedule('mediconnect-purge-job-runs', '17 3 * * *',
  $$delete from public.job_runs where started_at < now() - interval '30 days'$$);
select cron.schedule('mediconnect-purge-cron-history', '27 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);

-- =============================================================================
-- VERIFICAR
-- =============================================================================
--
-- Jobs programados:
--   select jobname, schedule, active from cron.job where jobname like 'mediconnect-%' order by 1;
--
-- Últimos disparos (¿pg_cron corre?):
--   select j.jobname, d.status, d.start_time
--   from cron.job_run_details d join cron.job j using (jobid)
--   where j.jobname like 'mediconnect-%' order by d.start_time desc limit 20;
--
-- Respuestas del backend (¿Render contesta 200?):
--   select status_code, timed_out, error_msg, created
--   from net._http_response order by created desc limit 20;
--
-- Corridas registradas por el backend (la verdad de negocio):
--   select job, status, started_at, duration_ms, result, error
--   from public.job_runs order by started_at desc limit 20;
--
-- Corridas por job en las últimas 24 h (lo que pide ENG-228):
--   select job, status, count(*) from public.job_runs
--   where started_at > now() - interval '24 hours' group by 1, 2 order by 1, 2;
--
-- =============================================================================
-- DESHACER
-- =============================================================================
--   select cron.unschedule(jobname) from cron.job where jobname like 'mediconnect-%';
--   drop function if exists scheduler.trigger_job(text);
--   drop schema if exists scheduler;
--   -- Los secretos de Vault se borran desde el dashboard (Project Settings → Vault).
