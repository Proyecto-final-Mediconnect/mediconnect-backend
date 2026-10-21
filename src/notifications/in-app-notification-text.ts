import { AR_TIMEZONE, toLocalDateTime } from '../common/time/argentina-time';

/** Lo que se le muestra al usuario de un aviso in-app. */
export interface InAppNotificationText {
  title: string;
  body: string;
}

const SHORT_DATE = new Intl.DateTimeFormat('es-AR', {
  timeZone: AR_TIMEZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/**
 * Arma el texto de un aviso in-app a partir de su tipo y su `payload` (ENG-69).
 *
 * El texto se arma en el servidor y no en cada cliente: así la web y la app
 * dicen lo mismo, y el formato de la fecha (hora de Argentina) se decide en un
 * solo lugar.
 *
 * El `payload` es JSON libre y lo escriben varios lados (este módulo, el seed
 * de demo). Cada campo se lee como opcional: si falta, el aviso sale igual con
 * un texto más genérico en vez de mostrar "undefined".
 */
export function renderInAppNotification(
  type: string,
  payload: unknown,
): InAppNotificationText {
  const p = asRecord(payload);
  const patient = text(p.patient);
  const professional = text(p.professional);
  const when = formatWhen(text(p.scheduledAt));

  switch (type) {
    case 'PAGO_CONFIRMADO':
      return patient
        ? {
            title: 'Turno nuevo confirmado',
            body: `${patient} reservó y pagó un turno${when ? ` para el ${when}` : ''}.`,
          }
        : {
            title: 'Pago confirmado',
            body: 'Se acreditó el pago y tu turno quedó confirmado.',
          };
    case 'TURNO_CANCELADO':
      return {
        title: 'Turno cancelado',
        body: `${patient ?? 'Un paciente'} canceló su turno${when ? ` del ${when}` : ''}. El horario quedó libre.`,
      };
    case 'TURNO_RESERVADO':
      return { title: 'Turno reservado', body: 'Tenés un turno reservado.' };
    case 'RECORDATORIO_24H':
      return {
        title: 'Tu turno es mañana',
        body: `Mañana tenés turno${withWho(patient, professional)}.`,
      };
    case 'RECORDATORIO_1H':
      return {
        title: 'Tu turno empieza en una hora',
        body: `En una hora tenés turno${withWho(patient, professional)}.`,
      };
    case 'NUEVO_MENSAJE':
      return { title: 'Mensaje nuevo', body: 'Tenés un mensaje sin leer.' };
    case 'RESENA_MODERADA':
      return {
        title: 'Tu reseña fue revisada',
        body: professional
          ? `Revisamos tu reseña sobre ${professional}.`
          : 'Revisamos tu reseña.',
      };
    default:
      return { title: 'Aviso', body: 'Tenés un aviso nuevo.' };
  }
}

function withWho(patient?: string, professional?: string): string {
  if (professional) return ` con ${professional}`;
  if (patient) return ` con ${patient}`;
  return '';
}

/** `el lunes 3 de noviembre a las 10:30` en hora de Argentina, o nada. */
function formatWhen(iso?: string): string | undefined {
  if (!iso) return undefined;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return undefined;
  return `${SHORT_DATE.format(instant)} a las ${toLocalDateTime(instant).startTime}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}
