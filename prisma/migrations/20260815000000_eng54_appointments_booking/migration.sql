-- EP-03 · Reserva de turnos (ENG-54) — GRANTs, políticas RLS y la unique que
-- impide la doble reserva.
--
-- Contexto de los dos caminos de datos que ya usa el proyecto:
--
--   * PostgREST con el JWT del usuario  → datos PROPIOS. RLS es la autoridad.
--     (ENG-47 perfil de paciente, ENG-48 perfil profesional, ENG-53 agenda.)
--   * Prisma como owner                 → datos PÚBLICOS de lectura.
--     (ENG-49 catálogo público de profesionales.)
--
-- ENG-54 usa los dos y por eso esta migración es más corta de lo que la nota que
-- dejó ENG-53 anticipaba:
--
--   > NOTA PARA ENG-54: un paciente va a necesitar LEER las reglas y los bloqueos
--   > de OTRO profesional [...] Eso requiere ampliar el SELECT más allá del dueño.
--
-- No hizo falta ampliarlo. La disponibilidad se calcula en el backend leyendo
-- `schedule_rules` / `schedule_blocks` / `appointments` **por Prisma**, igual que
-- ENG-49 lee el catálogo, y lo que sale al paciente son horarios libres — no las
-- filas. Abrir el SELECT de esas tablas a todo `authenticated` habría expuesto la
-- agenda completa de cada profesional a cualquier usuario logueado, y además
-- habría dejado los turnos de otros pacientes al alcance de un `GET` directo a
-- PostgREST. Así, `schedule_rules` y `schedule_blocks` siguen siendo, vía RLS,
-- solo del dueño.
--
-- Lo único que sí necesita RLS es la ESCRITURA del turno: el paciente inserta su
-- propia reserva con su JWT, y la base garantiza que no pueda reservar a nombre
-- de otro.
--
-- Todo idempotente: los GRANT son acumulativos, las políticas se recrean con
-- `drop policy if exists` y el índice usa `if not exists`.

-- ---------------------------------------------------------------------------
-- 1) La unique que impide la doble reserva
-- ---------------------------------------------------------------------------
-- Sin esto, dos pacientes que abren el mismo turno y confirman al mismo tiempo
-- pasan los dos la validación ("el turno está libre") y se insertan los dos: el
-- chequeo previo del service mira un estado que ya cambió cuando el INSERT llega.
-- Es la carrera clásica de un sistema de reservas y NO se arregla en la
-- aplicación; la tiene que arbitrar la base.
--
-- El índice es PARCIAL a propósito. Un unique común sobre
-- (professional_id, scheduled_at) impediría volver a vender un turno que se
-- canceló o se liberó, que es justo lo que tiene que poder pasar:
--
--   RESERVADO_SIN_PAGAR / CONFIRMADO  → ocupan el horario
--   CANCELADO / LIBERADO / COMPLETADO / NO_ASISTIO → no lo ocupan
--
-- COMPLETADO y NO_ASISTIO quedan afuera porque son estados de un turno que ya
-- pasó: para cuando un turno llega ahí, su horario es pasado y nadie lo reserva.
-- Incluirlos solo agrandaría el índice.
create unique index if not exists appointments_professional_active_slot_key
  on public.appointments (professional_id, scheduled_at)
  where status in (
    'RESERVADO_SIN_PAGAR'::appointment_status,
    'CONFIRMADO'::appointment_status
  );

-- ---------------------------------------------------------------------------
-- 2) appointments — GRANTs y RLS
-- ---------------------------------------------------------------------------
-- Sin UPDATE ni DELETE: un turno no se edita ni se borra. Cancelar es un cambio
-- de `status` con reglas de reembolso propias (ENG-65) y la liberación por falta
-- de pago la hace un job (ENG-101), no el paciente. Conceder UPDATE acá dejaría
-- que un paciente se ponga el turno en CONFIRMADO sin haber pagado.
grant select, insert on public.appointments to authenticated;

alter table public.appointments enable row level security;

-- Sin FORCE, igual que `schedule_rules` en ENG-53 y por el mismo motivo: el
-- backend calcula la disponibilidad leyendo esta tabla por Prisma (owner), y las
-- fixtures de los tests de integración también escriben por ahí. Las tablas con
-- FORCE siguen siendo las que tienen PII directa (profiles, patients,
-- professionals — ver 20260710000000_force_rls).
--
-- El dato sensible de esta tabla es la RELACIÓN paciente↔profesional, y de eso se
-- ocupa la política de abajo: cada uno ve únicamente los turnos en los que
-- participa. Un paciente no puede enumerar los turnos de otro.
drop policy if exists appointments_select_own on public.appointments;
create policy appointments_select_own on public.appointments
  for select to authenticated
  using (patient_id = auth.uid() or professional_id = auth.uid());

-- El paciente reserva, y solo para sí mismo. `with check` sobre `patient_id` es
-- lo que hace que el backend no tenga que confiar en el cuerpo del request: aunque
-- alguien mandara el UUID de otro paciente, la base rechaza el INSERT.
--
-- No se restringe el `status` desde acá porque la columna tiene DEFAULT
-- RESERVADO_SIN_PAGAR y el service nunca lo manda; si en el futuro se expusiera,
-- hay que agregar `and status = 'RESERVADO_SIN_PAGAR'` a este check.
drop policy if exists appointments_insert_own_patient on public.appointments;
create policy appointments_insert_own_patient on public.appointments
  for insert to authenticated
  with check (patient_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3) Índice para el cálculo de disponibilidad
-- ---------------------------------------------------------------------------
-- `appointments_professional_id_scheduled_at_idx` (EP-02/EP-10) ya cubre el
-- filtro por profesional y rango de fechas, que es la consulta caliente de la
-- pantalla de reserva. No hace falta ninguno más: el índice parcial del punto 1
-- resuelve además el chequeo de ocupación.
