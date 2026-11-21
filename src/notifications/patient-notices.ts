import { AR_TIMEZONE, toLocalDateTime } from '../common/time/argentina-time';

/**
 * Textos de los avisos al paciente sobre los cambios en su turno (ENG-204,
 * ENG-208, ADR-018).
 *
 * Una sola fuente para los tres canales —campanita, push y mail—, así dicen lo
 * mismo. Cada campo es opcional: el `payload` de un aviso es JSON libre y, si
 * falta algo, el texto sale igual, más genérico, en vez de mostrar "undefined".
 */

/** Tipos de aviso de este módulo (enum `notification_type`). */
export type PatientNoticeType =
  | 'TURNO_CANCELADO_PROFESIONAL'
  | 'REEMBOLSO_TOTAL'
  /** Se vence el plazo para elegir (ENG-208, caso 2). */
  | 'PLAZO_REPROGRAMACION_POR_VENCER'
  /** Comprobante de la cancelación que hizo el paciente (ENG-208). */
  | 'CANCELACION_CONFIRMADA'
  /** Un reembolso pendiente se acreditó o falló (ENG-208, caso 16). */
  | 'REEMBOLSO_ACTUALIZADO';

/** Los tipos de este módulo, para reconocerlos en la campanita. */
export const PATIENT_NOTICE_TYPES: readonly PatientNoticeType[] = [
  'TURNO_CANCELADO_PROFESIONAL',
  'REEMBOLSO_TOTAL',
  'PLAZO_REPROGRAMACION_POR_VENCER',
  'CANCELACION_CONFIRMADA',
  'REEMBOLSO_ACTUALIZADO',
];

/** Canal de Android de los avisos de turnos. Lo crea la app mobile. */
export const APPOINTMENTS_CHANNEL_ID = 'turnos';

/** Qué le pasó al turno cuando lo canceló el profesional. */
export type ProfessionalCancellationOutcome =
  /** Estaba pagado: el paciente elige otro horario o el 100 % (caso 1). */
  | 'A_REPROGRAMAR'
  /** Estaba sin pagar: se canceló y no hay plata en juego (caso 11). */
  | 'CANCELADO';

/** Por qué se devolvió el 100 %. */
export type FullRefundCause =
  /** El paciente eligió el reembolso. */
  | 'ELEGIDO'
  /** Venció el plazo para elegir (caso 2). */
  | 'VENCIDO';

export interface PatientNoticeData {
  professional?: string;
  /** ISO-8601 del horario original del turno. */
  scheduledAt?: string;
  reason?: string;
  outcome?: ProfessionalCancellationOutcome;
  /** ISO-8601 del vencimiento del plazo para elegir. */
  deadline?: string;
  amount?: number;
  currency?: string;
  cause?: FullRefundCause;
  /** Estado del reembolso en MercadoPago al momento del aviso. */
  refundStatus?: string;
  /** Porcentaje devuelto según la política (cancelación del paciente). */
  percent?: number;
  /**
   * ENG-237: por qué quedó a reprogramar si no fue una cancelación a mano: el
   * profesional no se conectó, o hubo una falla técnica.
   */
  reprogramCause?: ReprogramCause;
}

/** Por qué un turno quedó a reprogramar sin una cancelación a mano (ENG-237). */
export type ReprogramCause = 'AUSENCIA_PROFESIONAL' | 'FALLA_TECNICA';

export interface PatientNoticeText {
  title: string;
  /** Una o dos oraciones: entra en la campanita y en el push. */
  body: string;
}

const SHORT_DATE = new Intl.DateTimeFormat('es-AR', {
  timeZone: AR_TIMEZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

export function patientNoticeText(
  type: PatientNoticeType,
  data: PatientNoticeData,
): PatientNoticeText {
  const pro = data.professional ?? 'Tu profesional';
  const conPro = data.professional ? ` con ${data.professional}` : '';
  const when = formatWhen(data.scheduledAt);
  const del = when ? ` del ${when}` : '';

  if (type === 'TURNO_CANCELADO_PROFESIONAL') {
    const motivo = data.reason ? ` Motivo: "${data.reason}".` : '';
    if (data.outcome === 'CANCELADO') {
      return {
        title: 'Se canceló tu reserva',
        body: `${pro} canceló la reserva${del}.${motivo} Como no estaba paga, no se te cobró nada.`,
      };
    }
    const deadline = formatWhen(data.deadline);
    const opciones = `Elegí otro horario sin volver a pagar o pedí el reembolso del 100 %${deadline ? ` antes del ${deadline}` : ''}.`;
    if (data.reprogramCause === 'AUSENCIA_PROFESIONAL') {
      return {
        title: 'Tu consulta no se realizó',
        body: `${pro} no se conectó a tu consulta${del}. No perdés nada: ${opciones.charAt(0).toLowerCase()}${opciones.slice(1)}`,
      };
    }
    if (data.reprogramCause === 'FALLA_TECNICA') {
      return {
        title: 'Tu consulta no se pudo completar',
        body: `${pro} informó que tu consulta${del} no se pudo hacer por una falla técnica.${motivo} ${opciones}`,
      };
    }
    return {
      title: `${data.professional ?? 'Tu profesional'} no va a poder atenderte`,
      body: `${pro} canceló tu turno${del}.${motivo} ${opciones}`,
    };
  }

  const amount = formatAmount(data.amount, data.currency);

  if (type === 'PLAZO_REPROGRAMACION_POR_VENCER') {
    const deadline = formatWhen(data.deadline);
    return {
      title: 'Elegí qué hacer con tu turno',
      body: `Tu turno${conPro}${del} quedó a reprogramar. Tenés${deadline ? ` hasta el ${deadline}` : ' poco tiempo'} para elegir otro horario sin volver a pagar o pedir el reembolso del 100 %. Si no elegís, te devolvemos el 100 % igual.`,
    };
  }

  if (type === 'CANCELACION_CONFIRMADA') {
    const lead = `Cancelaste tu turno${conPro}${del}.`;
    if (data.percent === 0) {
      return {
        title: 'Cancelaste tu turno',
        body: `${lead} Con esa anticipación, la política de cancelación del profesional no prevé reembolso.`,
      };
    }
    const pct =
      typeof data.percent === 'number' ? ` (el ${data.percent} %)` : '';
    return {
      title: 'Cancelaste tu turno',
      body: `${lead} Te devolvemos ${amount ?? 'lo que corresponde según la política'}${pct}.${refundSuffix(data.refundStatus)}`,
    };
  }

  if (type === 'REEMBOLSO_ACTUALIZADO') {
    if (data.refundStatus === 'RECHAZADO') {
      return {
        title: 'Hubo un problema con tu reembolso',
        body: `No pudimos completar la devolución${amount ? ` de ${amount}` : ''} de tu turno${conPro}${del}. Escribinos y lo resolvemos.`,
      };
    }
    return {
      title: 'Se acreditó tu reembolso',
      body: `MercadoPago procesó la devolución${amount ? ` de ${amount}` : ''} de tu turno${conPro}${del}. Puede tardar unos días en verse en tu medio de pago.`,
    };
  }

  const devolvemos = `te devolvemos ${amount ?? 'lo que pagaste'} (el 100 %)`;
  const lead =
    data.cause === 'VENCIDO'
      ? `Venció el plazo para elegir un horario nuevo para tu turno${conPro}${del}, así que ${devolvemos}.`
      : `Pediste el reembolso de tu turno${conPro}${del}: ${devolvemos}.`;
  return {
    title: 'Te devolvemos el 100 %',
    body: `${lead}${refundSuffix(data.refundStatus)}`,
  };
}

/** Qué pasa con la plata, según el estado del reembolso al momento del aviso. */
function refundSuffix(status?: string): string {
  if (status === 'RECHAZADO') {
    return ' Hubo un problema con el reembolso: escribinos y lo resolvemos.';
  }
  if (status && status !== 'PROCESADO') {
    return ' Lo estamos procesando con MercadoPago; si en unos días no lo ves, escribinos.';
  }
  return ' Puede tardar unos días en verse en tu medio de pago.';
}

/** `lunes 3 de noviembre a las 10:30` en hora de Argentina, o nada. */
export function formatWhen(iso?: string): string | undefined {
  if (!iso) return undefined;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return undefined;
  return `${SHORT_DATE.format(instant)} a las ${toLocalDateTime(instant).startTime}`;
}

/** `$ 9.500` en pesos; otra moneda va con su código. Nada si no es un número. */
export function formatAmount(
  value: unknown,
  currency = 'ARS',
): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const number = new Intl.NumberFormat('es-AR', {
    maximumFractionDigits: 2,
  }).format(value);
  return currency === 'ARS' ? `$ ${number}` : `${currency} ${number}`;
}

/** Lee un `payload` de `notifications` como datos del aviso, sin confiar en su forma. */
export function noticeDataFromPayload(payload: unknown): PatientNoticeData {
  const p =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const str = (v: unknown) =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  const outcome = str(p.outcome);
  const cause = str(p.cause);
  return {
    professional: str(p.professional),
    scheduledAt: str(p.scheduledAt),
    reason: str(p.reason),
    outcome:
      outcome === 'A_REPROGRAMAR' || outcome === 'CANCELADO'
        ? outcome
        : undefined,
    deadline: str(p.deadline),
    amount: typeof p.amount === 'number' ? p.amount : undefined,
    currency: str(p.currency),
    cause: cause === 'ELEGIDO' || cause === 'VENCIDO' ? cause : undefined,
    refundStatus: str(p.refundStatus),
    percent: typeof p.percent === 'number' ? p.percent : undefined,
    reprogramCause:
      p.reprogramCause === 'AUSENCIA_PROFESIONAL' ||
      p.reprogramCause === 'FALLA_TECNICA'
        ? p.reprogramCause
        : undefined,
  };
}
