import { BOOKING_HORIZON_DAYS } from '../appointments/appointments.service';
import { MANUAL_CLOSE_HOURS_AFTER } from '../appointments/manual-close';
import { UNPAID_HOLD_MS } from '../appointments/unpaid-hold';
import { PLATFORM_CURRENCY } from '../common/currency';
import { LEGAL_VERSION } from '../legal/legal';
import { CODE_TTL_MS, SESSION_TTL_MS } from '../medipass/medipass.config';
import {
  MAX_FULL_REFUND_HOURS,
  MAX_POLICY_HOURS,
  MIN_PARTIAL_REFUND_PERCENT,
} from '../professionals/cancellation-policy';
import {
  JOIN_GRACE_MINUTES_AFTER,
  JOIN_OPENS_MINUTES_BEFORE,
} from '../video/consultation.config';

/**
 * ENG-229 — Las reglas de negocio que la web y la app necesitan conocer, tal
 * como las aplica el backend.
 *
 * Antes cada cliente las tenía copiadas con un comentario "espeja el backend".
 * Ahora las lee de acá (`GET /config`), y los plazos de cada turno vienen en el
 * turno (`paymentDueAt`, `joinOpensAt`…). Esto es para lo que se muestra antes
 * de que exista el turno o el código: "tenés N minutos para pagar", "la agenda
 * se publica hasta N días", "el código cambia cada N minutos".
 *
 * Todos los valores salen de las mismas constantes que usa el backend: cambiar
 * una regla es cambiarla en un solo lugar.
 */
export interface PublicConfig {
  /** Moneda de la plataforma (ISO 4217). */
  currency: string;
  /** Versión vigente de los textos legales (ENG-140). */
  legalVersion: string;
  booking: {
    /** Días que se publican de agenda, contando hoy. */
    horizonDays: number;
    /** Minutos desde la reserva para pagar antes de que se libere el horario. */
    paymentWindowMinutes: number;
  };
  videoConsultation: {
    /** Minutos antes del turno en que se abre la sala. */
    opensMinutesBefore: number;
    /** Minutos después del final del turno en que se sigue pudiendo entrar. */
    graceMinutesAfter: number;
  };
  appointments: {
    /** Horas después del final en que el profesional todavía puede cerrarlo. */
    manualCloseHoursAfter: number;
  };
  medipass: {
    /** Cada cuántos minutos cambia el código del pase. */
    codeMinutes: number;
    /** Cuántos minutos dura un acceso de emergencia. */
    sessionMinutes: number;
  };
  cancellationPolicy: {
    /** Tope de horas de anticipación configurables. */
    maxHours: number;
    /** La devolución total tiene que aplicar al menos desde estas horas antes. */
    maxFullRefundHours: number;
    /** La devolución parcial es de al menos este porcentaje. */
    minPartialRefundPercent: number;
  };
}

const MINUTE_MS = 60_000;

export const PUBLIC_CONFIG: Readonly<PublicConfig> = Object.freeze({
  currency: PLATFORM_CURRENCY,
  legalVersion: LEGAL_VERSION,
  booking: {
    horizonDays: BOOKING_HORIZON_DAYS,
    paymentWindowMinutes: UNPAID_HOLD_MS / MINUTE_MS,
  },
  videoConsultation: {
    opensMinutesBefore: JOIN_OPENS_MINUTES_BEFORE,
    graceMinutesAfter: JOIN_GRACE_MINUTES_AFTER,
  },
  appointments: { manualCloseHoursAfter: MANUAL_CLOSE_HOURS_AFTER },
  medipass: {
    codeMinutes: CODE_TTL_MS / MINUTE_MS,
    sessionMinutes: SESSION_TTL_MS / MINUTE_MS,
  },
  cancellationPolicy: {
    maxHours: MAX_POLICY_HOURS,
    maxFullRefundHours: MAX_FULL_REFUND_HOURS,
    minPartialRefundPercent: MIN_PARTIAL_REFUND_PERCENT,
  },
});
