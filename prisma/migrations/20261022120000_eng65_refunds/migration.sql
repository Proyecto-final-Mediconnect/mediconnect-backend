-- ENG-65 — Cancelar un turno y recibir reembolso si corresponde.
--
-- Dos cosas:
--
-- 1. La política de cancelación se congela en el turno al reservar, igual que el
--    precio (ENG-54). Si el profesional la cambia después (de 50 % a 0 %, por
--    ejemplo), el reembolso tiene que salir con la que vio el paciente al pagar
--    y no con la vigente. Lo pidió la review de backend#72.
-- 2. `refunds` guarda el id del reembolso de MercadoPago, para poder rastrearlo
--    y conciliarlo.
--
-- Las líneas `--;;` marcan el corte entre sentencias, igual que en ENG-63, y los
-- `IF NOT EXISTS` dejan que el spec de integración la aplique sobre una base que
-- ya armó `prisma db push` (ver `test/cancellation-policy-snapshot.integration.spec.ts`).

-- ---------------------------------------------------------------------------
-- 1) La copia de la política en el turno
-- ---------------------------------------------------------------------------
-- Las tres columnas son nullable, como en `cancellation_policies`, y se leen con
-- la misma regla (`resolvePolicy`): si alguna es NULL, aplica el default. Así el
-- default vive en un solo lugar, el código, y no duplicado acá.
--;;
ALTER TABLE "appointments"
  ADD COLUMN IF NOT EXISTS "policy_hours_full_refund" SMALLINT,
  ADD COLUMN IF NOT EXISTS "policy_hours_partial_refund" SMALLINT,
  ADD COLUMN IF NOT EXISTS "policy_partial_refund_percent" SMALLINT;

-- La copia la hace la base y no el backend. El paciente tiene INSERT sobre
-- `appointments` (ENG-54) con todas las columnas: si la política viniera en el
-- INSERT, cualquiera podría reservar por PostgREST con un 100 % de reembolso
-- hasta el último minuto. El trigger pisa lo que venga del cliente.
--
-- SECURITY DEFINER porque el que inserta es `authenticated`, que no tiene por
-- qué poder leer la política de otro profesional. El `search_path` vacío evita
-- que una función homónima en otro esquema se cuele en la ejecución.
--;;
CREATE OR REPLACE FUNCTION public.appointments_snapshot_cancellation_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Sin fila, SELECT INTO deja las tres en NULL: el profesional no configuró
  -- su política y aplica el default.
  SELECT cp.hours_full_refund, cp.hours_partial_refund, cp.partial_refund_percent
    INTO NEW.policy_hours_full_refund,
         NEW.policy_hours_partial_refund,
         NEW.policy_partial_refund_percent
    FROM public.cancellation_policies cp
   WHERE cp.professional_id = NEW.professional_id;
  RETURN NEW;
END;
$$;
--;;
REVOKE ALL ON FUNCTION public.appointments_snapshot_cancellation_policy() FROM PUBLIC;
--;;
DROP TRIGGER IF EXISTS appointments_snapshot_cancellation_policy ON public.appointments;
--;;
CREATE TRIGGER appointments_snapshot_cancellation_policy
  BEFORE INSERT ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.appointments_snapshot_cancellation_policy();

-- Los turnos que ya existen toman la política vigente: es la única que hubo,
-- porque ENG-67 entró el 21/10 y antes de eso todos tenían el default.
--;;
UPDATE public.appointments a
   SET policy_hours_full_refund = cp.hours_full_refund,
       policy_hours_partial_refund = cp.hours_partial_refund,
       policy_partial_refund_percent = cp.partial_refund_percent
  FROM public.cancellation_policies cp
 WHERE cp.professional_id = a.professional_id;

-- ---------------------------------------------------------------------------
-- 2) El id del reembolso en MercadoPago
-- ---------------------------------------------------------------------------
-- `refunds` no tiene GRANTs desde EP-02 y sigue sin tenerlos: la escribe solo el
-- backend, como `payments`. Si el paciente tiene que ver su reembolso, se lo
-- devuelve la cancelación.
--;;
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "mercadopago_refund_id" TEXT;
--;;
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;
