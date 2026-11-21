import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { renderNoticeEmail } from './appointment-emails';
import { EmailService } from './email.service';
import {
  APPOINTMENTS_CHANNEL_ID,
  type FullRefundCause,
  type PatientNoticeData,
  type PatientNoticeType,
  type ProfessionalCancellationOutcome,
  patientNoticeText,
} from './patient-notices';
import { PushService } from './push.service';

export { APPOINTMENTS_CHANNEL_ID };

/** Lo que se le informa al paciente del reembolso total. */
export interface FullRefundNotice {
  amount: number;
  status: string | null;
  cause: FullRefundCause;
}

/** Lo que se le informa al paciente de su propia cancelación. */
export interface PatientCancellationNotice {
  percent: number;
  amount: number;
  status: string | null;
}

/** Un reembolso pendiente que llegó a su estado final. */
export interface RefundUpdateNotice {
  refundId: string;
  amount: number;
  status: 'PROCESADO' | 'RECHAZADO';
}

/** Cómo sale cada aviso. */
interface SendOptions {
  /** El push repite lo que el paciente acaba de hacer en pantalla: ahí sobra. */
  push?: boolean;
  /** Clave de idempotencia del mail. Por defecto, el instante de la cancelación. */
  mailKey?: string;
}

/**
 * Avisos al paciente sobre los cambios en su turno (ENG-204, ENG-208,
 * ADR-018): campanita, push y mail, los tres con el mismo texto
 * (`patient-notices.ts`).
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

  /**
   * Se vence el plazo para elegir (ENG-208, caso 2). Lo manda el job de
   * vencimientos, una vez por cancelación.
   */
  async reprogramDeadlineSoon(
    appointmentId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.send(
      appointmentId,
      'PLAZO_REPROGRAMACION_POR_VENCER',
      now,
      (a) => ({ deadline: a.reprogram_deadline?.toISOString() }),
    );
  }

  /**
   * Comprobante de la cancelación que hizo el paciente (ENG-208): cuánto se le
   * devuelve y en qué estado está. Sin push: lo acaba de hacer en pantalla.
   */
  async patientCancelled(
    appointmentId: string,
    refund: PatientCancellationNotice,
    now: Date = new Date(),
  ): Promise<void> {
    await this.send(
      appointmentId,
      'CANCELACION_CONFIRMADA',
      now,
      (a) => ({
        percent: refund.percent,
        amount: refund.amount,
        currency: a.professional.currency,
        refundStatus: refund.status ?? undefined,
      }),
      { push: false },
    );
  }

  /**
   * Un reembolso que había quedado pendiente se acreditó o se dio por perdido
   * (ENG-208, caso 16). Lo manda el job de reintentos de ENG-205.
   */
  async refundUpdated(
    appointmentId: string,
    refund: RefundUpdateNotice,
    now: Date = new Date(),
  ): Promise<void> {
    await this.send(
      appointmentId,
      'REEMBOLSO_ACTUALIZADO',
      now,
      (a) => ({
        amount: refund.amount,
        currency: a.professional.currency,
        refundStatus: refund.status,
      }),
      // Un aviso por reembolso y estado: un reintento del job no lo repite.
      { mailKey: `${refund.refundId}:${refund.status}` },
    );
  }

  private async send(
    appointmentId: string,
    type: PatientNoticeType,
    now: Date,
    extra: (a: NoticeAppointment) => PatientNoticeData,
    options: SendOptions = {},
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
      options.push === false
        ? Promise.resolve()
        : this.pushTo(appointment, type, data),
      this.mail(appointment, type, data, now, options.mailKey),
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
    data: PatientNoticeData,
  ): Promise<void> {
    await this.push.sendToUser(a.patient_id, {
      ...pushText(type, data),
      data: { tipo: type, appointmentId: a.id },
      channelId: APPOINTMENTS_CHANNEL_ID,
    });
  }

  private async mail(
    a: NoticeAppointment,
    type: PatientNoticeType,
    data: PatientNoticeData,
    now: Date,
    mailKey?: string,
  ): Promise<void> {
    if (!this.email.isConfigured()) return;
    try {
      const { title, body } = patientNoticeText(type, data);
      const eligir =
        (type === 'TURNO_CANCELADO_PROFESIONAL' &&
          data.outcome === 'A_REPROGRAMAR') ||
        type === 'PLAZO_REPROGRAMACION_POR_VENCER';

      await this.email.send({
        to: a.patient.profile.email,
        ...renderNoticeEmail({
          greeting: `Hola ${a.patient.first_name}:`,
          title,
          body,
          url: this.webUrl(`/turnos/${a.id}`),
          label: eligir ? 'Elegir qué hacer con mi turno' : 'Ver el turno',
        }),
        // Por instante: un turno que el profesional cancela dos veces (caso 12)
        // manda dos mails, pero un reintento del mismo aviso no.
        idempotencyKey: `${a.id}:${type}:${mailKey ?? (a.cancelled_at ?? now).getTime()}`,
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

/**
 * El push aparece en la pantalla bloqueada: no lleva motivos, montos ni el
 * nombre del profesional. Dice qué pasó y lleva al turno, donde está el detalle.
 */
function pushText(
  type: PatientNoticeType,
  data: PatientNoticeData,
): { title: string; body: string } {
  switch (type) {
    case 'TURNO_CANCELADO_PROFESIONAL':
      return {
        title: 'Cambió tu turno',
        body: 'Tu profesional canceló un turno. Abrí la app para ver tus opciones.',
      };
    case 'PLAZO_REPROGRAMACION_POR_VENCER':
      return {
        title: 'Elegí qué hacer con tu turno',
        body: 'Se vence el plazo para elegir otro horario o el reembolso. Abrí la app para elegir.',
      };
    case 'REEMBOLSO_ACTUALIZADO':
      return data.refundStatus === 'RECHAZADO'
        ? {
            title: 'Problema con tu reembolso',
            body: 'No pudimos completar un reembolso. Abrí la app para ver cómo seguir.',
          }
        : {
            title: 'Se acreditó tu reembolso',
            body: 'MercadoPago procesó un reembolso. Abrí la app para ver el detalle.',
          };
    case 'CANCELACION_CONFIRMADA':
      return {
        title: 'Cancelaste tu turno',
        body: 'Abrí la app para ver el detalle del reembolso.',
      };
    default:
      return {
        title: 'Reembolso en camino',
        body: 'Te devolvemos el 100 % de un turno. Abrí la app para ver el detalle.',
      };
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
