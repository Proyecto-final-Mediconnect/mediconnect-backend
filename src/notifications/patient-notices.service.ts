import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { escapeHtml } from './appointment-emails';
import { EmailService } from './email.service';
import {
  type FullRefundCause,
  type PatientNoticeData,
  type PatientNoticeType,
  type ProfessionalCancellationOutcome,
  patientNoticeText,
} from './patient-notices';
import { PushService } from './push.service';

/** Canal de Android de los avisos de turnos. Lo crea la app mobile. */
export const APPOINTMENTS_CHANNEL_ID = 'turnos';

/** Lo que se le informa al paciente del reembolso total. */
export interface FullRefundNotice {
  amount: number;
  status: string | null;
  cause: FullRefundCause;
}

/**
 * Avisos al paciente cuando el profesional cancela su turno (ENG-204, ADR-018):
 * campanita, push y mail, los tres con el mismo texto (`patient-notices.ts`).
 *
 * ## Repetidos
 *
 * `notifications` admite un aviso por (turno, tipo, canal). Un turno reprogramado
 * que el profesional vuelve a cancelar (ADR-018, caso 12) generaría el mismo
 * aviso dos veces: en la campanita el nuevo **reemplaza** al anterior y vuelve a
 * aparecer como no leído, y el mail usa como clave de idempotencia el instante
 * de la cancelación, así que sale de nuevo.
 *
 * ## Nunca tira
 *
 * Lo llaman después de que el cambio de estado ya quedó escrito. Si un canal
 * falla, el turno sigue cancelado y los demás canales salen igual.
 */
@Injectable()
export class PatientNoticesService {
  private readonly logger = new Logger(PatientNoticesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly push: PushService,
    private readonly config: ConfigService,
  ) {}

  /** El profesional canceló: el turno quedó `A_REPROGRAMAR` o `CANCELADO`. */
  async professionalCancelled(
    appointmentId: string,
    outcome: ProfessionalCancellationOutcome,
    now: Date = new Date(),
  ): Promise<void> {
    await this.send(appointmentId, 'TURNO_CANCELADO_PROFESIONAL', now, (a) => ({
      reason: a.cancellation_reason ?? undefined,
      outcome,
      deadline: a.reprogram_deadline?.toISOString(),
    }));
  }

  /** Se devolvió (o se está devolviendo) el 100 % del turno. */
  async fullRefund(
    appointmentId: string,
    refund: FullRefundNotice,
    now: Date = new Date(),
  ): Promise<void> {
    await this.send(appointmentId, 'REEMBOLSO_TOTAL', now, (a) => ({
      amount: refund.amount,
      currency: a.professional.currency,
      cause: refund.cause,
      refundStatus: refund.status ?? undefined,
    }));
  }

  private async send(
    appointmentId: string,
    type: PatientNoticeType,
    now: Date,
    extra: (a: NoticeAppointment) => PatientNoticeData,
  ): Promise<void> {
    let appointment: NoticeAppointment | null;
    try {
      appointment = await this.prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: NOTICE_SELECT,
      });
    } catch (err) {
      this.logger.error(
        `No se pudo leer el turno ${appointmentId} para el aviso ${type}: ${String(err)}`,
      );
      return;
    }
    if (!appointment) return;

    // El nombre se congela en el aviso, como en ENG-69: si el profesional lo
    // cambia después, el aviso cuenta lo que pasó con el nombre de ese momento.
    const data: PatientNoticeData = {
      professional:
        `${appointment.professional.first_name} ${appointment.professional.last_name}`.trim(),
      scheduledAt: appointment.scheduled_at.toISOString(),
      ...extra(appointment),
    };
    const payload = { appointmentId, ...data } as Prisma.InputJsonObject;

    await Promise.all([
      this.inApp(appointment, type, payload, now),
      this.pushTo(appointment, type),
      this.mail(appointment, type, data, now),
    ]);
  }

  private async inApp(
    a: NoticeAppointment,
    type: PatientNoticeType,
    payload: Prisma.InputJsonObject,
    now: Date,
  ): Promise<void> {
    try {
      await this.prisma.notification.upsert({
        where: {
          appointment_id_type_channel: {
            appointment_id: a.id,
            type,
            channel: 'IN_APP',
          },
        },
        create: {
          user_id: a.patient_id,
          appointment_id: a.id,
          type,
          channel: 'IN_APP',
          payload,
          sent_at: now,
        },
        // Un aviso repetido (caso 12) reemplaza al anterior y vuelve a estar sin leer.
        update: { payload, sent_at: now, read_at: null, created_at: now },
      });
    } catch (err) {
      this.logger.error(
        `No se pudo dejar el aviso ${type} del turno ${a.id}: ${String(err)}`,
      );
    }
  }

  /**
   * El push no lleva el motivo ni montos: aparece en la pantalla bloqueada. Dice
   * qué pasó y lleva al turno, donde está el detalle.
   */
  private async pushTo(
    a: NoticeAppointment,
    type: PatientNoticeType,
  ): Promise<void> {
    const message =
      type === 'TURNO_CANCELADO_PROFESIONAL'
        ? {
            title: 'Cambió tu turno',
            body: 'Tu profesional canceló un turno. Abrí la app para ver tus opciones.',
          }
        : {
            title: 'Reembolso en camino',
            body: 'Te devolvemos el 100 % de un turno. Abrí la app para ver el detalle.',
          };
    await this.push.sendToUser(a.patient_id, {
      ...message,
      data: { tipo: type, appointmentId: a.id },
      channelId: APPOINTMENTS_CHANNEL_ID,
    });
  }

  private async mail(
    a: NoticeAppointment,
    type: PatientNoticeType,
    data: PatientNoticeData,
    now: Date,
  ): Promise<void> {
    if (!this.email.isConfigured()) return;
    try {
      const { title, body } = patientNoticeText(type, data);
      const url = this.webUrl(`/turnos/${a.id}`);
      const label =
        type === 'TURNO_CANCELADO_PROFESIONAL' &&
        data.outcome === 'A_REPROGRAMAR'
          ? 'Elegir qué hacer con mi turno'
          : 'Ver el turno';
      const greeting = `Hola ${a.patient.first_name}:`;

      await this.email.send({
        to: a.patient.profile.email,
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
        // Por instante: un turno que el profesional cancela dos veces (caso 12)
        // manda dos mails, pero un reintento del mismo aviso no.
        idempotencyKey: `${a.id}:${type}:${(a.cancelled_at ?? now).getTime()}`,
      });

      await this.prisma.notification.upsert({
        where: {
          appointment_id_type_channel: {
            appointment_id: a.id,
            type,
            channel: 'EMAIL',
          },
        },
        create: {
          user_id: a.patient_id,
          appointment_id: a.id,
          type,
          channel: 'EMAIL',
          sent_at: now,
        },
        update: { sent_at: now },
      });
    } catch (err) {
      this.logger.error(
        `No se pudo mandar el mail ${type} del turno ${a.id}: ${String(err)}`,
      );
    }
  }

  /** Una ruta de la web, o `null` si `WEB_ORIGIN` no es una URL única. */
  private webUrl(path: string): string | null {
    const configured = this.config.get<string>('WEB_ORIGIN');
    if (!configured || configured.includes(',')) return null;
    try {
      return `${new URL(configured).origin}${path}`;
    } catch {
      return null;
    }
  }
}

const NOTICE_SELECT = {
  id: true,
  patient_id: true,
  scheduled_at: true,
  cancellation_reason: true,
  cancelled_at: true,
  reprogram_deadline: true,
  professional: {
    select: { first_name: true, last_name: true, currency: true },
  },
  patient: {
    select: { first_name: true, profile: { select: { email: true } } },
  },
} as const;

type NoticeAppointment = Prisma.AppointmentGetPayload<{
  select: typeof NOTICE_SELECT;
}>;
