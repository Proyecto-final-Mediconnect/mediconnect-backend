-- ENG-45 · Prototipo de cadena de hash SHA-256 para la Historia Clínica (EP-06)
--
-- NO es una migración de Prisma, y está fuera de prisma/migrations a propósito:
-- crea una TABLA DE PRUEBA (`spike_hash_chain_entries`), no toca
-- `clinical_record_entries` y no debe correr en producción. ENG-57 se lleva de
-- acá el diseño ya validado, no este archivo.
--
-- Lo carga test/hash-chain.integration.spec.ts contra el Postgres de tests.
-- Los tests de integración aplican el esquema con `prisma db push`, que NO
-- ejecuta SQL suelto, así que este archivo se carga a mano desde el spec.
--
-- Las sentencias van separadas por `--;;` porque Prisma manda cada consulta
-- como prepared statement y no acepta varias en una sola llamada. Partir por
-- `;` no serviría: los cuerpos plpgsql están llenos de `;` adentro de `$$`.
--
-- Todo idempotente: se puede correr N veces sobre la misma base.

drop table if exists spike_hash_chain_entries cascade

--;;

-- `created_at` es timestamptz(3), NO (6) como en `clinical_record_entries`.
-- Es el hallazgo principal del spike: el hash incluye el timestamp, y un
-- timestamptz(6) leído desde Node vuelve como `Date` con precisión de
-- milisegundos. Los microsegundos se pierden en el round-trip, el hash
-- recalculado no coincide y la cadena da por manipulada una entrada sana.
-- Ver el informe del spike antes de definir el tipo en ENG-57.
-- Las columnas espejan a `clinical_record_entries`. `professional_id` y
-- `consultation_id` están acá porque también entran a la preimagen: la autoría
-- del asiento clínico tiene que estar protegida por la cadena (Ley 26.529
-- art. 15). Ver PREIMAGE_COLUMNS en src/common/hash-chain/hash-chain.ts — el
-- test de integración compara esta tabla contra esa lista y falla si divergen.
create table spike_hash_chain_entries (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid          not null,
  professional_id    uuid          not null,
  sequence_number    bigint        not null,
  entry_type         text          not null,
  fhir_resource_type text          not null,
  content            jsonb         not null,
  consultation_id    uuid,
  corrects_entry_id  uuid          references spike_hash_chain_entries (id),
  content_hash       char(64)      not null,
  previous_hash      char(64)      not null,
  created_at         timestamptz(3) not null,

  constraint spike_hash_chain_seq_unique unique (patient_id, sequence_number),
  constraint spike_hash_chain_seq_positive check (sequence_number >= 1),
  constraint spike_hash_chain_hash_hex check (
    content_hash ~ '^[0-9a-f]{64}$' and previous_hash ~ '^[0-9a-f]{64}$'
  )
)

--;;

create index spike_hash_chain_patient_seq
  on spike_hash_chain_entries (patient_id, sequence_number)

--;;

-- ---------------------------------------------------------------------------
-- Append-only: ni UPDATE ni DELETE, para nadie.
-- ---------------------------------------------------------------------------
-- Una corrección se registra como ENTRADA NUEVA que apunta a la corregida por
-- `corrects_entry_id`. La entrada errónea queda en la historia: eso es lo que
-- pide la Ley 26.529 y lo que hace auditable el registro.
--
-- El trigger frena al dueño de la tabla, que es más de lo que da RLS (el owner
-- la saltea salvo FORCE). No frena a un superusuario: puede deshabilitar el
-- trigger. Esa es justamente la brecha que la cadena de hash cubre, y la que
-- el test de manipulación reproduce.
create or replace function spike_hash_chain_block_mutation() returns trigger as $$
begin
  raise exception 'spike_hash_chain_entries es append-only: % no permitido', tg_op
    using errcode = '42501';
end;
$$ language plpgsql

--;;

create trigger spike_hash_chain_no_mutation
  before update or delete on spike_hash_chain_entries
  for each row execute function spike_hash_chain_block_mutation()

--;;

-- ---------------------------------------------------------------------------
-- Enlace verificado en el INSERT
-- ---------------------------------------------------------------------------
-- La base no calcula el hash (eso lo hace la aplicación), pero sí se niega a
-- guardar una entrada que no enganche con la cabeza de la cadena. Sin esto, un
-- bug del backend podría insertar una cadena rota y recién nos enteraríamos en
-- la verificación semanal (ENG-85).
create or replace function spike_hash_chain_check_link() returns trigger as $$
declare
  head_sequence bigint;
  head_hash     char(64);
begin
  select sequence_number, content_hash
    into head_sequence, head_hash
    from spike_hash_chain_entries
   where patient_id = new.patient_id
   order by sequence_number desc
   limit 1
     for update;

  if head_sequence is null then
    if new.sequence_number <> 1 then
      raise exception 'la primera entrada del paciente % debe tener sequence_number 1, llegó %',
        new.patient_id, new.sequence_number using errcode = '23514';
    end if;

    if new.previous_hash <> repeat('0', 64) then
      raise exception 'la primera entrada del paciente % debe encadenar con el hash génesis',
        new.patient_id using errcode = '23514';
    end if;
  else
    if new.sequence_number <> head_sequence + 1 then
      raise exception 'sequence_number no contiguo para el paciente %: esperaba %, llegó %',
        new.patient_id, head_sequence + 1, new.sequence_number using errcode = '23514';
    end if;

    if new.previous_hash <> head_hash then
      raise exception 'previous_hash no coincide con la cabeza de la cadena del paciente %',
        new.patient_id using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$ language plpgsql

--;;

create trigger spike_hash_chain_link
  before insert on spike_hash_chain_entries
  for each row execute function spike_hash_chain_check_link()

--;;

-- ---------------------------------------------------------------------------
-- Verificación del encadenamiento en SQL
-- ---------------------------------------------------------------------------
-- Solo revisa la estructura (génesis, contigüidad, enlace): NO recalcula el
-- SHA-256, porque la forma canónica del contenido la define la aplicación.
-- Es el chequeo barato para el job semanal; el caro (recalcular) corre en Node.
create or replace function spike_hash_chain_verify(p_patient_id uuid)
returns table (ok boolean, entries bigint, first_bad_sequence bigint, reason text) as $$
  with ordered as (
    select
      sequence_number,
      previous_hash,
      lag(content_hash)    over (order by sequence_number) as expected_previous,
      lag(sequence_number) over (order by sequence_number) as previous_sequence
    from spike_hash_chain_entries
    where patient_id = p_patient_id
  ),
  checked as (
    select
      sequence_number,
      case
        when previous_sequence is null and sequence_number <> 1
          then 'GENESIS_MISSING'
        when previous_sequence is null and previous_hash <> repeat('0', 64)
          then 'GENESIS_MISMATCH'
        when previous_sequence is not null and sequence_number <> previous_sequence + 1
          then 'SEQUENCE_GAP'
        when previous_sequence is not null and previous_hash <> expected_previous
          then 'BROKEN_LINK'
      end as reason
    from ordered
  ),
  failure as (
    select sequence_number, reason
    from checked
    where reason is not null
    order by sequence_number
    limit 1
  )
  select
    (select count(*) from failure) = 0,
    (select count(*) from ordered),
    (select sequence_number from failure),
    (select reason from failure);
$$ language sql stable
