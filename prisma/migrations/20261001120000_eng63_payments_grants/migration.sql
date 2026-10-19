-- EP-04 · Pago del turno con MercadoPago (ENG-63) — GRANTs y RLS de `payments`
--
-- `payments` existe como tabla desde EP-02 y hasta acá no tenía **ni un GRANT ni
-- una política**: nadie la escribía, así que el agujero estaba dormido. ENG-63 la
-- empieza a usar y por eso la cierra ahora, antes de que tenga filas.
--
-- Es el mismo patrón que ENG-48 (perfil profesional), ENG-54 (turnos) y ENG-57
-- (historia clínica): la tabla se crea en el esquema de EP-02, y los permisos los
-- trae la historia que la estrena.
--
-- Las líneas `--;;` son comentarios SQL que Prisma ignora: marcan el corte entre
-- sentencias para que el spec de integración pueda cargar el archivo statement
-- por statement.

-- ---------------------------------------------------------------------------
-- 1) GRANTs — solo lectura, y solo del propio pago
-- ---------------------------------------------------------------------------
-- **Sin INSERT ni UPDATE para `authenticated`, y acá es todavía más claro que en
-- las otras tablas: esto es plata.**
--
--   * El `amount` lo congela el backend desde el turno. Si el cliente pudiera
--     insertar, podría crear su propio `Payment` por $1 y el webhook de ENG-64
--     —que compara lo cobrado contra `payments.amount`— daría el turno por
--     pagado.
--   * El `status` lo mueve únicamente el webhook, contra lo que responde la API
--     de MercadoPago. Un UPDATE desde el navegador sería ponerse `APROBADO` solo.
--
-- El SELECT existe para que el paciente pueda ver el estado de su pago sin pasar
-- por el backend en cada poll.
--;;
grant select on public.payments to authenticated;

-- ---------------------------------------------------------------------------
-- 2) RLS
-- ---------------------------------------------------------------------------
-- Sin FORCE, igual que `appointments` (ENG-54) y a diferencia de la HC: el
-- backend escribe esta tabla por Prisma como owner —el webhook es público y no
-- tiene JWT de nadie— y con FORCE habría que darle permisos explícitos a un rol
-- que hoy no existe. El dato sensible acá no es contenido clínico sino el monto
-- y el estado, y de eso se ocupa la política de abajo.
--;;
alter table public.payments enable row level security;

-- El paciente ve el pago de SUS turnos.
--
-- La relación va por `appointments` porque `payments` no tiene `patient_id`: el
-- pago cuelga del turno, no de la persona. Duplicar el `patient_id` acá sería
-- una segunda fuente de verdad sobre de quién es el pago, y la que se
-- desincroniza es siempre la copia.
--
-- El profesional NO ve el pago. Le alcanza con el estado del turno
-- (`CONFIRMADO`), que es lo que necesita para atender; el detalle del cobro
-- —medio de pago, id de MercadoPago— es del paciente. Si alguna vez el
-- profesional necesita ver su liquidación, eso es otra historia y otra vista.
--;;
drop policy if exists payments_select_own_patient on public.payments;
--;;
create policy payments_select_own_patient
  on public.payments
  for select to authenticated
  using (
    exists (
      select 1
      from public.appointments a
      where a.id = payments.appointment_id
        and a.patient_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 3) Índice para esa política
-- ---------------------------------------------------------------------------
-- El `exists` se evalúa por fila. `appointments` ya tiene su PK sobre `id`, que
-- es por donde entra el join, así que no hace falta ninguno nuevo sobre
-- `appointments`. `payments.appointment_id` ya es UNIQUE desde EP-02 (un pago
-- por turno), y esa unique sirve como índice para la búsqueda del webhook.
--
-- Se deja anotado para que ENG-65 (reembolsos) no lo vuelva a averiguar.

-- ---------------------------------------------------------------------------
-- 4) `payment_webhook_events` queda cerrada
-- ---------------------------------------------------------------------------
-- La bitácora de webhooks no la lee nadie desde el navegador: es forense, la
-- escribe el endpoint público de ENG-64 por Prisma y se consulta por SQL cuando
-- hay que investigar un pago. RLS activa con cero políticas = negar por defecto,
-- igual que `consultations` y `video_sessions` en ENG-56.
--
-- Importa más que en otras tablas: `raw_payload` guarda el cuerpo crudo que
-- mandó MercadoPago, que incluye datos del pagador.
--;;
alter table public.payment_webhook_events enable row level security;
