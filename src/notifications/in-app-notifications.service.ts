import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  renderInAppNotification,
  type InAppNotificationText,
} from './in-app-notification-text';

/** `P2002` de Prisma: violación de unicidad. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** Cuántos avisos devuelve la bandeja. Los viejos no se borran, solo no se listan. */
const INBOX_LIMIT = 30;

/** Avisos al profesional sobre sus turnos (ENG-69). */
export type ProfessionalAppointmentNotice =
  | 'PAGO_CONFIRMADO'
  | 'TURNO_CANCELADO';

export interface InAppNotificationView extends InAppNotificationText {
  id: string;
  type: string;
  appointmentId: string | null;
  /** Conversación de un aviso `NUEVO_MENSAJE` (ENG-70), para que la campanita lleve al chat. */
  conversationId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface InAppInbox {
  unreadCount: number;
  notifications: InAppNotificationView[];
}

/**
 * Avisos in-app (ENG-69): la campanita del shell privado.
 *
 * ## Qué se le avisa al profesional
 *
 * - **`PAGO_CONFIRMADO`**: un paciente reservó y pagó. Sale cuando el webhook
 *   confirma el turno, no al reservar: una reserva sin pagar es una retención
 *   que se libera sola a los 15 minutos (ENG-101), y avisarla sería anunciar un
 *   turno que quizás no existe. Es el mismo criterio que el email de ENG-68.
 * - **`TURNO_CANCELADO`**: el paciente canceló. Hoy solo el paciente puede
 *   cancelar (ENG-55), así que el aviso va siempre al profesional.
 *
 * Usa la misma unicidad `(appointment_id, type, channel)` que los emails: un
 * webhook que llega dos veces no deja dos avisos.
 */
@Injectable()
export class InAppNotificationsService {
  private readonly logger = new Logger(InAppNotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deja el aviso en la bandeja del profesional del turno.
   *
   * **Nunca tira.** Lo llaman el webhook y la cancelación después de que el
   * cambio de estado ya pasó: si el aviso falla, el turno sigue confirmado (o
   * cancelado) y eso es lo importante.
   */
  async notifyProfessional(
    appointmentId: string,
    type: ProfessionalAppointmentNotice,
    now: Date = new Date(),
  ): Promise<void> {
    try {
      const appointment = await this.prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: {
          professional_id: true,
          scheduled_at: true,
          patient: { select: { first_name: true, last_name: true } },
        },
      });
      if (!appointment) return;

      await this.prisma.notification.create({
        data: {
          user_id: appointment.professional_id,
          appointment_id: appointmentId,
          type,
          channel: 'IN_APP',
          // El nombre se congela en el aviso: si el paciente lo cambia después,
          // el aviso cuenta lo que pasó con el nombre de ese momento.
          payload: {
            appointmentId,
            patient:
              `${appointment.patient.first_name} ${appointment.patient.last_name}`.trim(),
            scheduledAt: appointment.scheduled_at.toISOString(),
          },
          sent_at: now,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === PRISMA_UNIQUE_VIOLATION) return;
      this.logger.error(
        `No se pudo dejar el aviso ${type} del turno ${appointmentId}: ${String(err)}`,
      );
    }
  }

  /**
   * Avisa que llegó un mensaje de chat (ENG-70).
   *
   * **Un aviso por conversación sin leer**, no uno por mensaje: diez mensajes
   * seguidos dejan un solo "Fulano te escribió", que se apaga al abrir el chat
   * (`markConversationRead`). La unicidad de turno no aplica acá
   * (`appointment_id` es `null`), así que el control es esta consulta previa:
   * dos mensajes simultáneos pueden dejar dos avisos, y es un costo aceptable.
   *
   * **Nunca tira**, por lo mismo que `notifyProfessional`: el mensaje ya quedó
   * guardado y eso es lo importante.
   */
  async notifyNewMessage(
    recipientId: string,
    conversationId: string,
    from: string,
    now: Date = new Date(),
  ): Promise<void> {
    try {
      const pending = await this.prisma.notification.count({
        where: {
          ...this.conversationNotices(recipientId, conversationId),
          read_at: null,
        },
      });
      if (pending > 0) return;

      await this.prisma.notification.create({
        data: {
          user_id: recipientId,
          type: 'NUEVO_MENSAJE',
          channel: 'IN_APP',
          payload: { conversationId, from },
          sent_at: now,
        },
      });
    } catch (err) {
      this.logger.error(
        `No se pudo dejar el aviso de mensaje de la conversación ${conversationId}: ${String(err)}`,
      );
    }
  }

  /** Apaga el aviso de mensaje nuevo de una conversación al abrirla (ENG-70). */
  async markConversationRead(
    userId: string,
    conversationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        ...this.conversationNotices(userId, conversationId),
        read_at: null,
      },
      data: { read_at: now },
    });
  }

  private conversationNotices(userId: string, conversationId: string) {
    return {
      user_id: userId,
      type: 'NUEVO_MENSAJE' as const,
      channel: 'IN_APP' as const,
      payload: { path: ['conversationId'], equals: conversationId },
    };
  }

  /** La bandeja del usuario: los últimos avisos in-app y cuántos no leyó. */
  async listMine(userId: string): Promise<InAppInbox> {
    const where = { user_id: userId, channel: 'IN_APP' as const };

    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: INBOX_LIMIT,
        select: {
          id: true,
          type: true,
          payload: true,
          appointment_id: true,
          created_at: true,
          read_at: true,
        },
      }),
      this.prisma.notification.count({ where: { ...where, read_at: null } }),
    ]);

    return {
      unreadCount,
      notifications: rows.map((row) => ({
        id: row.id,
        type: row.type,
        appointmentId: row.appointment_id,
        conversationId: conversationIdOf(row.payload),
        createdAt: row.created_at.toISOString(),
        readAt: row.read_at?.toISOString() ?? null,
        ...renderInAppNotification(row.type, row.payload),
      })),
    };
  }

  /**
   * Marca un aviso propio como leído. Es idempotente: marcar uno ya leído no
   * cambia su fecha de lectura.
   *
   * Un aviso de otro usuario da 404, igual que uno inexistente: un 403
   * confirmaría que el id existe.
   */
  async markRead(
    userId: string,
    notificationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const owned = {
      id: notificationId,
      user_id: userId,
      channel: 'IN_APP' as const,
    };

    const { count } = await this.prisma.notification.updateMany({
      where: { ...owned, read_at: null },
      data: { read_at: now },
    });
    if (count > 0) return;

    const exists = await this.prisma.notification.count({ where: owned });
    if (exists === 0) throw new NotFoundException('Ese aviso no existe.');
  }
}

function conversationIdOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>).conversationId;
  return typeof value === 'string' ? value : null;
}
