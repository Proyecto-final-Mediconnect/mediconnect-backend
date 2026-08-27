-- EP-06 · Modelo de datos de Historia Clínica con cadena de hash (ENG-57)
--
-- `clinical_record_entries` existe como tabla desde EP-02, pero hasta acá estaba
-- **completamente desprotegida**: sin GRANTs, sin RLS y sin ningún trigger. Es
-- decir, la tabla más sensible del proyecto era la única sin una sola regla. Esta
-- migración la vuelve usable y la cierra.
--
-- Aplica a la tabla real el diseño que validó el spike ENG-45 sobre
-- `spike_hash_chain_entries`. Lo que allá era una tabla de juguete, acá es la
-- historia clínica: append-only por trigger, encadenamiento verificado en el
-- INSERT, y el hash calculado por la aplicación.
--
-- El fix bloqueante del spike (`created_at` a timestamptz(3) sin `default now()`)
-- NO va acá: ya lo aplicó ENG-85 en 20260815000000_eng85_integrity_checks, que
-- necesitaba la cadena verificable para su job semanal.
--
-- Todo idempotente: los GRANT son acumulativos, las políticas y los triggers se
-- recrean con `drop ... if exists`.
--
-- Las líneas `--;;` son comentarios SQL y Prisma las ignora: marcan el corte
-- entre sentencias para que `test/clinical-records.integration.spec.ts` pueda
-- cargar este archivo statement por statement. Prisma manda cada consulta como
-- prepared statement y no acepta varias juntas, y partir por `;` no serviría
-- porque los cuerpos plpgsql están llenos de `;` adentro de `$$`.

-- ---------------------------------------------------------------------------
-- 1) GRANTs — solo lectura, y solo para el paciente
-- ---------------------------------------------------------------------------
-- **No hay INSERT para `authenticated`, y es la decisión central de esta
-- migración.** Las entradas las escribe el backend por Prisma (owner), nunca el
-- navegador, porque el `content_hash` lo calcula la aplicación sobre una forma
-- canónica del contenido (ver src/common/hash-chain/hash-chain.ts). Si el cliente
-- pudiera insertar:
--
--   * podría sellar una entrada con un `created_at` que no es el real, y la
--     cadena la aceptaría porque el hash cerraría igual;
--   * y la fecha de un asiento clínico es justamente lo que la Ley 26.529 pide
--     que sea confiable.
--
-- Tampoco UPDATE ni DELETE, que además están bloqueados por trigger más abajo:
-- una corrección es una ENTRADA NUEVA que apunta a la corregida.
--
-- El SELECT es el que habilita a ENG-59 (el paciente ve su propia HC).
--;;
grant select on public.clinical_record_entries to authenticated;

-- ---------------------------------------------------------------------------
-- 2) RLS
-- ---------------------------------------------------------------------------
-- FORCE, como `profiles` / `patients` / `professionals` (20260710000000_force_rls)
-- y a diferencia de `appointments`: esta tabla no tiene PII, tiene la historia
-- clínica completa. Si alguna tabla del proyecto justifica el modo estricto, es
-- esta.
--
-- FORCE hace que RLS aplique también al owner. El backend sigue leyendo y
-- escribiendo por Prisma porque conecta como `postgres`, que tiene BYPASSRLS y
-- evade RLS incluso con FORCE — la misma nota que dejó ENG-37 y el motivo por el
-- que el job de integridad de ENG-85 sigue pudiendo recorrer todas las cadenas.
-- Cuando el backend pase a un rol dedicado no-owner (el ticket de seguridad que
-- quedó pendiente), FORCE empieza a morder de verdad y va a haber que darle a ese
-- rol permisos explícitos.
--;;
alter table public.clinical_record_entries enable row level security;
--;;
alter table public.clinical_record_entries force  row level security;

-- El paciente ve su propia historia clínica. Nada más.
--;;
drop policy if exists clinical_record_entries_select_own_patient
  on public.clinical_record_entries;
--;;
create policy clinical_record_entries_select_own_patient
  on public.clinical_record_entries
  for select to authenticated
  using (patient_id = auth.uid());

-- NOTA PARA ENG-60 (ver la HC de un paciente como profesional):
--
-- Falta a propósito la política que deja a un profesional leer la HC de su
-- paciente, porque es una decisión de producto y no de modelo de datos, y
-- conviene que la tome quien implemente esa historia:
--
--   ¿el profesional ve TODA la historia del paciente, o solo las entradas que
--   escribió él? La primera es la que da valor clínico —para eso existe una HC
--   unificada— pero es también la que MediPass está diseñado para gatear con sus
--   tres niveles de acceso (Release 3). Ponerla abierta hoy y cerrarla después es
--   más difícil que al revés.
--
-- Si se opta por el acceso amplio, la forma es esta (el vínculo ya existe: la
-- tabla `appointments` está desde ENG-54):
--
--   create policy clinical_record_entries_select_assigned_professional
--     on public.clinical_record_entries
--     for select to authenticated
--     using (
--       professional_id = auth.uid()
--       or exists (
--         select 1 from public.appointments a
--         where a.patient_id = clinical_record_entries.patient_id
--           and a.professional_id = auth.uid()
--       )
--     );
--
-- Ojo con el `exists`: se evalúa por fila, así que conviene medirlo contra una HC
-- larga antes de darlo por bueno.

-- ---------------------------------------------------------------------------
-- 3) Append-only
-- ---------------------------------------------------------------------------
-- Ni UPDATE ni DELETE, para nadie: es el requisito de inalterabilidad de la
-- **Ley 26.529 art. 15**, y es lo que hace que la cadena de hash signifique algo.
--
-- El trigger frena incluso al dueño de la tabla, que es más de lo que da RLS. No
-- frena a un superusuario —puede deshabilitar el trigger—, y esa es justamente la
-- brecha que cubre la cadena de hash: la manipulación deja de ser imposible y
-- pasa a ser detectable (ENG-85).
--
-- `raise` con 42501 (insufficient_privilege) y no un error genérico, para que el
-- backend pueda distinguirlo de un fallo de conexión.
--;;
create or replace function clinical_record_entries_block_mutation()
returns trigger as $$
begin
  raise exception
    'clinical_record_entries es append-only (Ley 26.529 art. 15): % no permitido. Una corrección es una entrada nueva con corrects_entry_id.',
    tg_op
    using errcode = '42501';
end;
$$ language plpgsql;

--;;
drop trigger if exists clinical_record_entries_no_mutation
  on public.clinical_record_entries;
--;;
create trigger clinical_record_entries_no_mutation
  before update or delete on public.clinical_record_entries
  for each row execute function clinical_record_entries_block_mutation();

-- ---------------------------------------------------------------------------
-- 4) El encadenamiento se verifica en el INSERT
-- ---------------------------------------------------------------------------
-- La base no calcula el hash —eso lo hace la aplicación, ver el informe del spike
-- ENG-45 para el porqué— pero sí se niega a guardar una entrada que no enganche
-- con la cabeza de la cadena del paciente.
--
-- Sin esto, un bug del backend podría escribir una cadena rota y nos
-- enteraríamos recién en la corrida semanal de ENG-85, con las entradas ya
-- guardadas y sin poder corregirlas: la tabla es append-only.
--;;
create or replace function clinical_record_entries_check_link()
returns trigger as $$
declare
  head_sequence bigint;
  head_hash     char(64);
begin
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
$$ language plpgsql;

--;;
drop trigger if exists clinical_record_entries_link
  on public.clinical_record_entries;
--;;
create trigger clinical_record_entries_link
  before insert on public.clinical_record_entries
  for each row execute function clinical_record_entries_check_link();

-- ---------------------------------------------------------------------------
-- 5) Formato de los hashes
-- ---------------------------------------------------------------------------
-- `char(64)` acota el largo pero no el alfabeto: sin este check, un
-- `previous_hash` con 64 espacios entraría igual. Es barato y cierra la puerta.
--;;
alter table public.clinical_record_entries
  drop constraint if exists clinical_record_entries_hash_hex;
--;;
alter table public.clinical_record_entries
  add constraint clinical_record_entries_hash_hex check (
    content_hash  ~ '^[0-9a-f]{64}$' and
    previous_hash ~ '^[0-9a-f]{64}$'
  );

-- `sequence_number` arranca en 1 y no en 0: el génesis es el `previous_hash` de
-- 64 ceros, no una entrada de índice cero.
--;;
alter table public.clinical_record_entries
  drop constraint if exists clinical_record_entries_sequence_positive;
--;;
alter table public.clinical_record_entries
  add constraint clinical_record_entries_sequence_positive
  check (sequence_number >= 1);
