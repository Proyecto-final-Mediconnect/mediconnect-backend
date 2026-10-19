-- ENG-100 · La cabeza movida de la cadena se informa como serialization_failure
--
-- El trigger de la cadena rechaza con `23514` (check_violation) tanto los errores
-- de la entrada (cruzar historias, génesis mal formado) como la carrera de "otra
-- escritura cambió la cabeza". El service tenía que distinguir la carrera leyendo
-- el texto del `raise` a través del formato `Debug` del engine de Prisma: un
-- acoplamiento a una frase en castellano y a un formato interno que nadie
-- controla desde el service.
--
-- `40001` (serialization_failure) es justo lo que significa: "perdiste la carrera,
-- reintentá". Prisma lo mapea a `P2034` (`PrismaClientKnownRequestError`), así que
-- el service lo detecta por `code`, igual que el `P2002`.
--
-- Solo cambia el `raise` de `sequence_number no contiguo`. `previous_hash no
-- coincide` queda en `23514` a propósito: con el número contiguo, la cabeza es la
-- misma fila que leyó el service, así que un hash distinto no es una carrera sino
-- un bug de sellado o una cadena manipulada, y tiene que seguir saliendo ruidoso.
--
-- Es `create or replace` de la función de ENG-126: el trigger que la usa no se
-- toca. La migración de ENG-126 ya está mergeada y no se edita.
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
        new.patient_id, head_sequence + 1, new.sequence_number using errcode = '40001';
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

