-- EP-06 · Agregar una entrada a la HC (ENG-58) — el profesional lee lo que firmó
--
-- ENG-57 dejó `clinical_record_entries` con una sola política de SELECT: el
-- paciente ve su propia historia. Faltaba, a propósito, la del profesional,
-- porque "¿ve toda la HC o solo lo suyo?" es una decisión de producto que le
-- corresponde a ENG-60.
--
-- ENG-58 agrega **la mitad que no tiene discusión**: un profesional puede ver las
-- entradas que él mismo firmó. No hace falta ninguna decisión de alcance para
-- afirmar eso, y sin ello el formulario de esta historia sería ciego — el
-- profesional escribiría un asiento clínico sin poder releer lo que acaba de
-- escribir, ni lo que escribió en la consulta anterior del mismo paciente.
--
-- **Sigue pendiente para ENG-60** la decisión de si el profesional ve además las
-- entradas de OTROS profesionales del mismo paciente. Esta política no la
-- adelanta ni la bloquea: son dos policies independientes y en RLS se suman
-- (basta con que una deje pasar la fila).
--
-- Idempotente: la política se recrea con `drop policy if exists`.

--;;
drop policy if exists clinical_record_entries_select_own_authored
  on public.clinical_record_entries;
--;;
create policy clinical_record_entries_select_own_authored
  on public.clinical_record_entries
  for select to authenticated
  using (professional_id = auth.uid());

-- Nota sobre el INSERT: sigue sin haber GRANT para `authenticated`, y ENG-58 no
-- lo agrega. El profesional no escribe la entrada por PostgREST: la manda al
-- backend, que la sella (calcula el `content_hash` sobre la forma canónica del
-- contenido y fija el `created_at` que entra a la preimagen) y la guarda por
-- Prisma. El porqué está en la migración de ENG-57 y en el informe del spike
-- ENG-45.
--
-- Quién puede escribir en la HC de quién tampoco lo decide la base: lo valida
-- `ClinicalRecordsService.assertCanWriteFor`, que exige un turno entre ese
-- profesional y ese paciente. Es una regla de negocio con una tabla de por medio
-- (`appointments`), no una condición sobre la fila que se inserta.
