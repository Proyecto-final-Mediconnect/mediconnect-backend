import { AR_TIMEZONE, toLocalDateTime } from '../common/time/argentina-time';

/** Tipos de aviso de turno que se mandan por email (enum `notification_type`). */
export type AppointmentEmailKind =
  | 'TURNO_RESERVADO'
  | 'RECORDATORIO_24H'
  | 'RECORDATORIO_1H'
  | 'RESENA_PEDIDA';

export interface AppointmentEmailData {
  patientFirstName: string;
  professionalName: string;
  scheduledAt: Date;
  durationMinutes: number;
  /** URL de "Mis turnos" en la web, o `null` si no hay `WEB_ORIGIN` válido. */
  myAppointmentsUrl: string | null;
  /** URL del turno en la web, donde está el formulario de reseña (ENG-190). */
  appointmentUrl?: string | null;
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
      RESENA_PEDIDA: {
        subject: `¿Cómo fue tu consulta con ${pro}?`,
        lead: `Contanos cómo te fue en tu consulta con ${pro} del ${date}.`,
      },
    };
  const { subject, lead } = copy[kind];
  const pideResena = kind === 'RESENA_PEDIDA';

  const details = pideResena
    ? 'Tu opinión ayuda a otros pacientes a elegir, y te lleva un minuto. Te lo pedimos una sola vez.'
    : `Es una videoconsulta de ${data.durationMinutes} minutos. Podés entrar desde "Mis turnos" unos minutos antes de la hora.`;
  const cancel =
    kind === 'RECORDATORIO_1H' || pideResena
      ? null
      : 'Si no vas a poder asistir, cancelalo desde "Mis turnos" así el horario queda libre para otra persona.';
  // El pedido de reseña lleva al turno, donde está el formulario; los avisos de
  // turno, a "Mis turnos". Si la web pide ingresar, vuelve al mismo link.
  const link = pideResena
    ? {
        url: data.appointmentUrl ?? data.myAppointmentsUrl,
        label: 'Calificar la consulta',
      }
    : // ENG-208: el aviso lleva directo al turno, donde se entra a la consulta
      // o se cancela. Sin el link del turno, a "Mis turnos".
      data.appointmentUrl
      ? { url: data.appointmentUrl, label: 'Ver el turno' }
      : { url: data.myAppointmentsUrl, label: 'Ver mis turnos' };

  const text = [
    `Hola ${data.patientFirstName}:`,
    '',
    lead,
    details,
    ...(cancel ? [cancel] : []),
    ...(link.url ? ['', `${link.label}: ${link.url}`] : []),
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
      link.url
        ? `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`
        : ''
    }
    <p style="color: #6b7280;">MediConnect</p>
  </body>
</html>`;

  return { subject, html, text };
}

/** Lo que lleva el mail de un aviso del ciclo del turno (ENG-204, ENG-208). */
export interface NoticeEmailData {
  greeting: string;
  title: string;
  body: string;
  /** Link a la pantalla donde se actúa, o `null` si no hay `WEB_ORIGIN` válido. */
  url: string | null;
  label: string;
}

/**
 * El mail de un aviso: el mismo título y texto que la campanita, con un botón a
 * la pantalla del turno. Escapa todo lo que va al HTML.
 */
export function renderNoticeEmail(data: NoticeEmailData): RenderedEmail {
  const { greeting, title, body, url, label } = data;
  return {
    subject: title,
    text: [
      greeting,
      '',
      body,
      ...(url ? ['', `${label}: ${url}`] : []),
      '',
      'MediConnect',
    ].join('\n'),
    html: `<!doctype html>
<html lang="es">
  <body style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
    <p>${escapeHtml(greeting)}</p>
    <p>${escapeHtml(body)}</p>
    ${url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>` : ''}
    <p style="color: #6b7280;">MediConnect</p>
  </body>
</html>`,
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
