-- EP-06 · Ver la HC de un paciente como profesional (ENG-60)
--
-- ENG-57 dejó una sola política de SELECT (el paciente ve lo suyo) y ENG-58
-- agregó la mitad sin discusión (el profesional ve lo que él firmó). La decisión
-- de alcance quedó explícitamente diferida a esta historia:
--
--   ¿el profesional ve TODA la historia del paciente, o solo lo que escribió él?
--
-- **Se resuelve por el acceso amplio: ve toda la HC del paciente.** Es lo que le
-- da sentido clínico a una HC unificada —el cardiólogo necesita leer al clínico
-- que derivó— y es lo que asume el diseño de la pantalla: la vista del
-- profesional filtra las entradas *por profesional*, lo que solo tiene sentido si
-- ve las de otros.
--
-- ENG-57 advirtió que abrir hoy y cerrar después es más difícil que al revés, y
-- que MediPass va a gatear esto con sus tres niveles en Release 3. La advertencia
-- sigue en pie: cuando MediPass llegue, esta política es la que hay que angostar,
-- y por eso lleva nombre propio en vez de ampliar la de ENG-58.
--
-- Las políticas de RLS se SUMAN: basta con que una deje pasar la fila. Esta no
-- reemplaza a `..._select_own_authored` ni a `..._select_own_patient`; convive.
--
-- Idempotente: se recrea con `drop policy if exists`.

-- ---------------------------------------------------------------------------
-- 1) Qué cuenta como relación profesional-paciente
-- ---------------------------------------------------------------------------
-- Un turno **reservado en adelante**: desde que el paciente reserva, ya es su
-- paciente. Eso incluye `RESERVADO_SIN_PAGAR`, `CONFIRMADO` y `COMPLETADO`.
--
-- El único estado que NO habilita es `CANCELADO`: un turno que se dio de baja
-- nunca constituyó una relación de atención, y sin este filtro un turno cancelado
-- hace un año le daría a ese profesional la HC completa del paciente para
-- siempre.
--
-- El acceso no caduca mientras el turno siga en pie: la continuidad de la
-- atención es justamente lo que una HC longitudinal tiene que sostener.
--;;
drop policy if exists clinical_record_entries_select_assigned_professional
  on public.clinical_record_entries;
--;;
create policy clinical_record_entries_select_assigned_professional
  on public.clinical_record_entries
  for select to authenticated
  using (
    exists (
      select 1
      from public.appointments a
      where a.patient_id = clinical_record_entries.patient_id
        and a.professional_id = auth.uid()
        and a.status <> 'CANCELADO'
    )
  );

-- ---------------------------------------------------------------------------
-- 2) Índice para el `exists`
-- ---------------------------------------------------------------------------
-- ENG-57 dejó dicho "ojo con el `exists`: se evalúa por fila". Los índices que ya
-- existen en `appointments` son `(professional_id, scheduled_at)` y
-- `(patient_id, scheduled_at)`; ninguno sirve acá, porque el predicado es por
-- `(patient_id, professional_id)` y no toca `scheduled_at`.
--
-- Con este índice el `exists` resuelve por index-only scan y corta en la primera
-- fila, así que el costo por fila de la HC es constante en vez de proporcional a
-- los turnos del paciente.
--;;
create index if not exists appointments_patient_professional_idx
  on public.appointments (patient_id, professional_id)
  where status <> 'CANCELADO';
