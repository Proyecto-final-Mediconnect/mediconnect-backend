import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { reviewableWhere } from '../reviews/reviewable';
import { JOIN_GRACE_MINUTES_AFTER } from '../video/consultation.config';
import {
  renderAppointmentEmail,
  type AppointmentEmailKind,
} from './appointment-emails';
import { EmailDeliveryError, EmailService } from './email.service';

const HOUR_MS = 60 * 60 * 1000;

/** Tope de envíos por tipo y corrida. El job pasa cada 5 minutos: si un día se
 *  junta más, sale en las corridas siguientes en vez de en un request eterno. */
const BATCH_SIZE = 50;

/** Cuánto después de que cierra la sala sale el pedido de reseña (ENG-190). */
export const REVIEW_REQUEST_DELAY_MS = 3 * HOUR_MS;

/**
 * Hasta cuánto después del cierre de la sala se sigue mandando el pedido. Sin
 * este corte, el primer deploy le pediría la reseña de cada turno completado
 * de la historia, incluidos los de la seed.
 */
export const REVIEW_REQUEST_MAX_AGE_MS = 3 * 24 * HOUR_MS;

/** `P2002` de Prisma: violación de unicidad. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

const APPOINTMENT_SELECT = {
  id: true,
  patient_id: true,
  scheduled_at: true,
  duration_minutes: true,
  created_at: true,
  patient: {
    select: { first_name: true, profile: { select: { email: true } } },
  },
  professional: { select: { first_name: true, last_name: true } },
} as const;

interface DueAppointment {
  id: string;
  patient_id: string;
  scheduled_at: Date;
  duration_minutes: number;
  created_at: Date;
  patient: { first_name: string; profile: { email: string } };
  professional: { first_name: string; last_name: string };
}

type Delivery = 'enviado' | 'ya-enviado' | 'fallido' | 'reintentar';

export interface SendSummary {
  /** `false` si falta configurar el email: no se intentó nada. */
  enabled: boolean;
  sent: number;
  failed: number;
}

/**
 * Emails de turno al paciente (ENG-68): confirmación y recordatorios a 24 h y a
 * 1 h.
 *
 * ## Cuándo sale cada uno
 *
 * - **Confirmación (`TURNO_RESERVADO`)**: cuando el turno pasa a `CONFIRMADO`,
 *   es decir, cuando se acredita el pago. No al reservar: con Checkout Pro una
 *   reserva sin pagar se libera a los 15 minutos (ENG-101), y confirmarla por
 *   mail sería prometer un turno que quizás no existe. La dispara el webhook en
 *   el momento y el job la reintenta si falló.
 * - **24 h**: cuando faltan 24 h o menos (y más de 1 h). Solo si el turno se
 *   reservó con más de 24 h de anticipación. Si no, la confirmación acaba de
 *   salir y un recordatorio encima es ruido.
 * - **1 h**: cuando falta 1 h o menos. Misma regla, con 1 h de anticipación.
 *
 * Todo lo dispara el job `POST /internal/jobs/send-appointment-reminders`
 * (cada 5 minutos), así que un aviso puede salir unos minutos después de su
 * hora exacta.
 *
 * ## Que no salga dos veces
 *
 * Antes de mandar se **reclama** el envío insertando la fila en
 * `notifications`. La unicidad `(appointment_id, type, channel)` hace que, si el
 * webhook y el job llegan juntos, solo uno inserte y solo ese mande.
 * - Si el envío falla por algo transitorio (Resend caído, 429, API key mal
 *   cargada), se borra la fila y la próxima corrida lo reintenta.
 * - Si falla por algo permanente (dirección inválida), la fila queda con el
 *   error y no se reintenta.
 *
 * La fila no guarda el email del destinatario: es PII y el error de Resend
 * alcanza para diagnosticar.
 */
@Injectable()
export class AppointmentNotificationsService {
  private readonly logger = new Logger(AppointmentNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /** Lo que llama el job: todo aviso que ya debería haber salido. */
  async sendDue(now: Date = new Date()): Promise<SendSummary> {
    if (!this.email.isConfigured()) {
      this.logger.warn(
        'Emails de turno deshabilitados: falta RESEND_API_KEY o EMAIL_FROM.',
      );
      return { enabled: false, sent: 0, failed: 0 };
    }

    const due: [DueAppointment, AppointmentEmailKind][] = [
      ...(await this.dueConfirmations(now)).map(
        (a) => [a, 'TURNO_RESERVADO'] as [DueAppointment, AppointmentEmailKind],
      ),
      ...(await this.dueReminders(now, 24 * HOUR_MS, HOUR_MS)).map(
        (a) =>
          [a, 'RECORDATORIO_24H'] as [DueAppointment, AppointmentEmailKind],
      ),
      ...(await this.dueReminders(now, HOUR_MS, 0)).map(
        (a) => [a, 'RECORDATORIO_1H'] as [DueAppointment, AppointmentEmailKind],
      ),
    ];

    const summary: SendSummary = { enabled: true, sent: 0, failed: 0 };
    // De a uno: el plan gratis de Resend acepta 2 requests por segundo.
    for (const [appointment, kind] of due) {
      const result = await this.deliver(appointment, kind, now);
      if (result === 'enviado') summary.sent += 1;
      if (result === 'fallido' || result === 'reintentar') summary.failed += 1;
    }

    if (due.length > 0) {
      this.logger.log(
        `Emails de turno: ${summary.sent} enviados, ${summary.failed} fallidos.`,
      );
    }
    return summary;
  }

  /**
   * Pedido de reseña (ENG-190): **un** mail por turno, 3 horas después de que
   * cierra la sala. Lo llama el job `send-review-requests`.
   *
   * Sale solo si el turno es reseñable (completado, o el paciente entró a la
   * sala), no tiene reseña ni descarte, y el paciente no apagó los mails
   * (`email_reminders`, ENG-86). Que no salga dos veces lo garantiza la misma
   * fila reclamada en `notifications` que usan los recordatorios.
   */
  async sendReviewRequests(now: Date = new Date()): Promise<SendSummary> {
    if (!this.email.isConfigured()) {
      return { enabled: false, sent: 0, failed: 0 };
    }

    // La sala cierra a `scheduled_at + duración + tolerancia`, y la duración es
    // por turno: se acota por fecha en la consulta y se termina de filtrar en
    // memoria, igual que `dueReminders`.
    const graceMs = JOIN_GRACE_MINUTES_AFTER * 60_000;
    const rows = await this.prisma.appointment.findMany({
      where: {
        ...reviewableWhere(now),
        scheduled_at: {
          gte: new Date(
            now.getTime() - REVIEW_REQUEST_MAX_AGE_MS - 24 * HOUR_MS,
          ),
          lte: new Date(now.getTime() - REVIEW_REQUEST_DELAY_MS - graceMs),
        },
        review: { is: null },
        review_prompt_dismissal: { is: null },
        notifications: { none: { type: 'RESENA_PEDIDA', channel: 'EMAIL' } },
        patient: { profile: { email_reminders: true } },
      },
      select: APPOINTMENT_SELECT,
      // Del más nuevo al más viejo: los que se pasan de los 3 días (que el
      // filtro de abajo descarta) quedan al final de la tanda y no tapan a
      // los que sí hay que mandar (review de #114).
      orderBy: { scheduled_at: 'desc' },
      take: BATCH_SIZE,
    });

    const due = rows.filter((row) => {
      const closesAt =
        row.scheduled_at.getTime() + row.duration_minutes * 60_000 + graceMs;
      const age = now.getTime() - closesAt;
      return age >= REVIEW_REQUEST_DELAY_MS && age <= REVIEW_REQUEST_MAX_AGE_MS;
    });

    const summary: SendSummary = { enabled: true, sent: 0, failed: 0 };
    for (const appointment of due) {
      const result = await this.deliver(appointment, 'RESENA_PEDIDA', now);
      if (result === 'enviado') summary.sent += 1;
      if (result === 'fallido' || result === 'reintentar') summary.failed += 1;
    }
    if (due.length > 0) {
      this.logger.log(
        `Pedidos de reseña: ${summary.sent} enviados, ${summary.failed} fallidos.`,
      );
    }
    return summary;
  }

  /**
   * Confirmación inmediata, la llama el webhook apenas confirma el turno.
   *
   * **Nunca tira.** El turno ya quedó confirmado y eso es lo importante. Si el
   * mail falla, el job lo reintenta.
   */
  async sendConfirmation(
    appointmentId: string,
    now: Date = new Date(),
  ): Promise<void> {
    try {
      if (!this.email.isConfigured()) return;

      const appointment = await this.prisma.appointment.findFirst({
        where: {
          id: appointmentId,
          status: 'CONFIRMADO',
          scheduled_at: { gt: now },
        },
        select: APPOINTMENT_SELECT,
      });
      if (!appointment) return;

      await this.deliver(appointment, 'TURNO_RESERVADO', now);
    } catch (err) {
      this.logger.error(
        `No se pudo mandar la confirmación del turno ${appointmentId}: ${String(err)}`,
      );
    }
  }

  /**
   * Turnos confirmados que todavía no tienen su email de confirmación.
   *
   * Solo los confirmados en las últimas 24 h (`updated_at`, que el webhook toca
   * al confirmar). Sin ese corte, el primer deploy le mandaría una
   * "confirmación" a cada turno confirmado antes de que existiera esta historia.
   */
  private dueConfirmations(now: Date): Promise<DueAppointment[]> {
    return this.prisma.appointment.findMany({
      where: {
        status: 'CONFIRMADO',
        scheduled_at: { gt: now },
        updated_at: { gte: new Date(now.getTime() - 24 * HOUR_MS) },
        notifications: { none: { type: 'TURNO_RESERVADO', channel: 'EMAIL' } },
      },
      select: APPOINTMENT_SELECT,
      orderBy: { scheduled_at: 'asc' },
      take: BATCH_SIZE,
    });
  }

  /**
   * Turnos confirmados que empiezan entre `now + notBefore` y `now + lead`, y
   * que no tienen este recordatorio.
   *
   * `notBefore` es el límite inferior de la ventana: el de 24 h no sale si ya
   * falta menos de 1 h, porque ahí corresponde el de 1 h.
   *
   * La regla de anticipación (`created_at` al menos `lead` antes del turno)
   * compara dos columnas, y Prisma no lo expresa en un `where`. Se filtra en
   * memoria: la ventana es chica y ya viene acotada por fecha.
   */
  private async dueReminders(
    now: Date,
    lead: number,
    notBefore: number,
  ): Promise<DueAppointment[]> {
    const type = lead === HOUR_MS ? 'RECORDATORIO_1H' : 'RECORDATORIO_24H';

    const rows = await this.prisma.appointment.findMany({
      where: {
        status: 'CONFIRMADO',
        scheduled_at: {
          gt: new Date(now.getTime() + notBefore),
          lte: new Date(now.getTime() + lead),
        },
        notifications: { none: { type, channel: 'EMAIL' } },
        // Oposición (ENG-86): quien apagó los recordatorios no los recibe.
        // La confirmación de la reserva no pasa por acá y sigue saliendo.
        patient: { profile: { email_reminders: true } },
      },
      select: APPOINTMENT_SELECT,
      orderBy: { scheduled_at: 'asc' },
      take: BATCH_SIZE,
    });

    return rows.filter(
      (row) => row.created_at.getTime() <= row.scheduled_at.getTime() - lead,
    );
  }

  /** Reclama el envío, manda y registra el resultado. */
  private async deliver(
    appointment: DueAppointment,
    kind: AppointmentEmailKind,
    now: Date,
  ): Promise<Delivery> {
    let claimId: string;
    try {
      const claim = await this.prisma.notification.create({
        data: {
          user_id: appointment.patient_id,
          appointment_id: appointment.id,
          type: kind,
          channel: 'EMAIL',
        },
        select: { id: true },
      });
      claimId = claim.id;
    } catch (err) {
      if ((err as { code?: string }).code === PRISMA_UNIQUE_VIOLATION) {
        return 'ya-enviado';
      }
      throw err;
    }

    const rendered = renderAppointmentEmail(kind, {
      patientFirstName: appointment.patient.first_name,
      professionalName: `${appointment.professional.first_name} ${appointment.professional.last_name}`,
      scheduledAt: appointment.scheduled_at,
      durationMinutes: appointment.duration_minutes,
      myAppointmentsUrl: this.myAppointmentsUrl(),
      appointmentUrl: this.webUrl(`/turnos/${appointment.id}`),
    });

    try {
      await this.email.send({
        to: appointment.patient.profile.email,
        ...rendered,
        idempotencyKey: `${appointment.id}:${kind}`,
      });
      await this.prisma.notification.update({
        where: { id: claimId },
        data: { sent_at: now },
      });
      return 'enviado';
    } catch (err) {
      const permanent = err instanceof EmailDeliveryError && err.permanent;
      this.logger.error(
        `Falló el email ${kind} del turno ${appointment.id} (${permanent ? 'no se reintenta' : 'se reintenta'}): ${String(err)}`,
      );

      if (permanent) {
        await this.prisma.notification.update({
          where: { id: claimId },
          data: { payload: { error: String(err).slice(0, 500) } },
        });
        return 'fallido';
      }

      await this.prisma.notification.delete({ where: { id: claimId } });
      return 'reintentar';
    }
  }

  /**
   * Link a "Mis turnos" de la web, o `null` si `WEB_ORIGIN` no es una URL única.
   * El mail sale igual sin el link: la fecha y la hora son lo que importa.
   */
  private myAppointmentsUrl(): string | null {
    return this.webUrl('/mis-turnos');
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
