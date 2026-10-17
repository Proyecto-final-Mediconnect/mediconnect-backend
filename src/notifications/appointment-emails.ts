import { AR_TIMEZONE, toLocalDateTime } from '../common/time/argentina-time';

/** Tipos de aviso de turno que se mandan por email (enum `notification_type`). */
export type AppointmentEmailKind =
  | 'TURNO_RESERVADO'
  | 'RECORDATORIO_24H'
  | 'RECORDATORIO_1H';

export interface AppointmentEmailData {
  patientFirstName: string;
  professionalName: string;
  scheduledAt: Date;
  durationMinutes: number;
  /** URL de "Mis turnos" en la web, o `null` si no hay `WEB_ORIGIN` válido. */
  myAppointmentsUrl: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const LONG_DATE = new Intl.DateTimeFormat('es-AR', {
  timeZone: AR_TIMEZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/**
 * Arma el email de un aviso de turno, en HTML y en texto plano.
 *
 * Los nombres vienen de la base y los cargan los propios usuarios: se escapan
 * antes de meterlos en el HTML. Sin eso, un profesional que se pusiera
 * `<a href=…>` en el apellido inyectaría un link en el mail de cada paciente.
 * El asunto y el texto plano no se interpretan como HTML, así que van sin
 * escapar.
 */
export function renderAppointmentEmail(
  kind: AppointmentEmailKind,
  data: AppointmentEmailData,
): RenderedEmail {
  const date = LONG_DATE.format(data.scheduledAt);
  const { startTime } = toLocalDateTime(data.scheduledAt);
  const when = `el ${date} a las ${startTime} (hora de Argentina)`;
  const pro = data.professionalName;

  const copy: Record<AppointmentEmailKind, { subject: string; lead: string }> =
    {
      TURNO_RESERVADO: {
        subject: `Tu turno con ${pro} está confirmado`,
        lead: `Recibimos el pago y tu turno con ${pro} quedó confirmado para ${when}.`,
      },
      RECORDATORIO_24H: {
        subject: `Recordatorio: tu turno con ${pro} es mañana`,
        lead: `Te recordamos que tenés turno con ${pro} ${when}.`,
      },
      RECORDATORIO_1H: {
        subject: `Tu turno con ${pro} empieza en una hora`,
        lead: `Tu turno con ${pro} empieza en una hora, a las ${startTime} (hora de Argentina).`,
      },
    };
  const { subject, lead } = copy[kind];

  const details = `Es una videoconsulta de ${data.durationMinutes} minutos. Podés entrar desde "Mis turnos" unos minutos antes de la hora.`;
  const cancel =
    kind === 'RECORDATORIO_1H'
      ? null
      : 'Si no vas a poder asistir, cancelalo desde "Mis turnos" así el horario queda libre para otra persona.';

  const text = [
    `Hola ${data.patientFirstName}:`,
    '',
    lead,
    details,
    ...(cancel ? [cancel] : []),
    ...(data.myAppointmentsUrl
      ? ['', `Mis turnos: ${data.myAppointmentsUrl}`]
      : []),
    '',
    'MediConnect',
  ].join('\n');

  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
    <p>Hola ${escapeHtml(data.patientFirstName)}:</p>
    <p>${escapeHtml(lead)}</p>
    <p>${escapeHtml(details)}</p>
    ${cancel ? `<p>${escapeHtml(cancel)}</p>` : ''}
    ${
      data.myAppointmentsUrl
        ? `<p><a href="${escapeHtml(data.myAppointmentsUrl)}">Ver mis turnos</a></p>`
        : ''
    }
    <p style="color: #6b7280;">MediConnect</p>
  </body>
</html>`;

  return { subject, html, text };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
