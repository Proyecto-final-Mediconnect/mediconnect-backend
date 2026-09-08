-- EP-06 · Endurecer el modelo de HC (ENG-126)
--
-- Tres huecos detectados al revisar ENG-57 (PR backend #43). Ninguno rompe lo
-- que el modelo hace hoy; los tres muerden más adelante.
--
-- Las líneas `--;;` son comentarios SQL que Prisma ignora: marcan el corte entre
-- sentencias para que los tests de integración puedan cargar el archivo statement
-- por statement. Misma convención que la migración de ENG-57.
--
-- Todo idempotente.

-- ---------------------------------------------------------------------------
-- 1) `SECURITY DEFINER` en las funciones de trigger
-- ---------------------------------------------------------------------------
-- ENG-57 anticipó el paso del backend a un rol dedicado no-owner y dijo que
-- habría que darle "permisos explícitos". El problema no van a ser los permisos:
-- va a ser la VISIBILIDAD.
--
-- `clinical_record_entries_check_link` hace `select ... where patient_id =
-- new.patient_id` para encontrar la cabeza de la cadena. Corriendo como el
-- invocador bajo RLS, ese select queda filtrado por las políticas de SELECT de la
-- tabla. Con las que hay hoy —`patient_id = auth.uid()` de ENG-57 y
-- `professional_id = auth.uid()` de ENG-58— un profesional vería sus propias
-- entradas pero NO las de otros profesionales del mismo paciente.
--
-- O sea que la cabeza que calcularía sería stale: el trigger validaría contra una
-- cadena más corta que la real y dejaría pasar una entrada con `previous_hash`
-- incorrecto. Deja de fallar limpio y pasa a escribir cadena rota, que es
-- exactamente lo que la tabla no puede permitirse siendo append-only.
--
-- `SECURITY DEFINER` hace que la función corra como su dueño (el owner de la
-- tabla), así que ve la cadena COMPLETA sin importar quién dispara el insert. No
-- afloja nada: quién puede insertar lo siguen decidiendo los GRANT y las
-- políticas, esto solo arregla lo que el trigger es capaz de VER al validar.
--
-- `set search_path` es obligatorio en toda función `security definer`: sin él,
-- quien la invoca puede anteponer un esquema propio y hacer que `public.` resuelva
-- a una tabla suya. `pg_temp` va último por la misma razón.
--
-- Hoy esto no cambia nada —el backend es owner y tiene BYPASSRLS— y ese es el
-- punto: se aplica ANTES de migrar el rol, no después de que rompa.

-- ---------------------------------------------------------------------------
-- 2) `corrects_entry_id` tiene que apuntar al MISMO paciente
-- ---------------------------------------------------------------------------
-- La FK de EP-02 solo exige que el id exista en la tabla. Nada impide que una
-- entrada CORRECCION de la HC de A referencie una entrada de la HC de B, que es
-- mezclar dos historias clínicas — y como la tabla es append-only, después no se
-- puede deshacer.
--
-- Va acá y no en ENG-100 porque es una invariante del modelo, no de la historia
-- que lo consume. Cualquier camino que inserte una corrección tiene que respetarla.
--
-- Se valida en el trigger y no con una FK compuesta a propósito. La FK compuesta
-- —`unique (id, patient_id)` + `foreign key (corrects_entry_id, patient_id)`—
-- sería más declarativa, pero obligaría a cambiar la relación en `schema.prisma` a
-- una referencia de dos campos y a regenerar el cliente. No vale ese costo para
-- una regla que el trigger de al lado ya está en posición de verificar.
--;;
create or replace function clinical_record_entries_check_link()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  head_sequence     bigint;
  head_hash         char(64);
  corrected_patient uuid;
begin
  -- Una corrección solo puede apuntar a una entrada de la MISMA historia.
  if new.corrects_entry_id is not null then
    select patient_id
      into corrected_patient
      from public.clinical_record_entries
     where id = new.corrects_entry_id;

    if corrected_patient is null then
      raise exception
        'la entrada corregida % no existe', new.corrects_entry_id
        using errcode = '23503';
    end if;

    if corrected_patient <> new.patient_id then
      raise exception
        'una corrección no puede cruzar historias clínicas: la entrada % es del paciente %, y esta entrada es del paciente %',
        new.corrects_entry_id, corrected_patient, new.patient_id
        using errcode = '23514';
    end if;
  end if;

  select sequence_number, content_hash
    into head_sequence, head_hash
    from public.clinical_record_entries
   where patient_id = new.patient_id
   order by sequence_number desc
   limit 1
     for update;

  if head_sequence is null then
    if new.sequence_number <> 1 then
      raise exception
        'la primera entrada de la HC del paciente % debe tener sequence_number 1, llegó %',
        new.patient_id, new.sequence_number using errcode = '23514';
    end if;

    if new.previous_hash <> repeat('0', 64) then
      raise exception
        'la primera entrada de la HC del paciente % debe encadenar con el hash génesis',
        new.patient_id using errcode = '23514';
    end if;
  else
    if new.sequence_number <> head_sequence + 1 then
      raise exception
        'sequence_number no contiguo en la HC del paciente %: esperaba %, llegó %',
        new.patient_id, head_sequence + 1, new.sequence_number using errcode = '23514';
    end if;

    if new.previous_hash <> head_hash then
      raise exception
        'previous_hash no coincide con la cabeza de la cadena del paciente %',
        new.patient_id using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

--;;
create or replace function clinical_record_entries_block_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception
    'clinical_record_entries es append-only (Ley 26.529 art. 15): % no permitido. Una corrección es una entrada nueva con corrects_entry_id.',
    tg_op
    using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) `TRUNCATE` también
-- ---------------------------------------------------------------------------
-- `clinical_record_entries_no_mutation` es `for each row`, y TRUNCATE no dispara
-- triggers de fila: no hay filas que recorrer, borra el archivo entero. La
-- migración de ENG-57 afirma que "el trigger frena incluso al dueño de la tabla",
-- y eso vale para UPDATE y DELETE pero no para TRUNCATE.
--
-- Importa porque el backend conecta como `postgres`, que es el owner. Un
-- `TRUNCATE ... CASCADE` desde código que corre como owner vacía la historia
-- clínica entera —y arrastra `consultation_summaries`, que la referencia— sin que
-- el trigger diga nada.
--
-- La red que había es de detección, no de prevención: el job semanal de ENG-85
-- compara contra `chain_head_snapshots` y detecta el truncado. Pero es semanal y
-- post-hoc: te enterás con la tabla ya vacía y sin nada que reconstruir, porque
-- append-only significa que tampoco hay historial de borrados.
--
-- `for each statement` es la única forma para TRUNCATE. Sigue sin frenar a un
-- superusuario, que puede deshabilitar el trigger — ese escalón lo cubre la cadena
-- de hash, que convierte la manipulación en detectable.
--;;
drop trigger if exists clinical_record_entries_no_truncate
  on public.clinical_record_entries;
--;;
create trigger clinical_record_entries_no_truncate
  before truncate on public.clinical_record_entries
  for each statement execute function clinical_record_entries_block_mutation();
