import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { REVIEWABLE_WHERE } from './reviewable';

/** Hasta cuántos días después del turno se sigue pidiendo la reseña. */
export const PENDING_REVIEW_DAYS = 30;

/** Un turno que el paciente puede reseñar y todavía no reseñó (ENG-190). */
export interface PendingReviewView {
  appointmentId: string;
  scheduledAt: string;
  professional: {
    id: string;
    firstName: string;
    lastName: string;
    photoUrl: string | null;
  };
}

/**
 * El pedido de reseña del inicio (ENG-190): qué turnos faltan reseñar y el
 * descarte de la tarjeta.
 *
 * El descarte vive en la base (`review_prompt_dismissals`) y no en el
 * dispositivo: descartada en la web no vuelve en la app, y el mail del job
 * tampoco sale.
 */
@Injectable()
export class ReviewPromptsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Turnos reseñables del paciente de los últimos {@link PENDING_REVIEW_DAYS}
   * días, sin reseña y sin descartar, del más reciente al más viejo.
   */
  async listPending(
    patientId: string,
    now: Date = new Date(),
  ): Promise<PendingReviewView[]> {
    const rows = await this.prisma.appointment.findMany({
      where: {
        ...REVIEWABLE_WHERE,
        patient_id: patientId,
        scheduled_at: {
          gte: new Date(now.getTime() - PENDING_REVIEW_DAYS * 86_400_000),
          lte: now,
        },
        review: { is: null },
        review_prompt_dismissal: { is: null },
      },
      select: {
        id: true,
        scheduled_at: true,
        professional: {
          select: {
            profile_id: true,
            first_name: true,
            last_name: true,
            photo_url: true,
          },
        },
      },
      orderBy: { scheduled_at: 'desc' },
    });

    return rows.map((row) => ({
      appointmentId: row.id,
      scheduledAt: row.scheduled_at.toISOString(),
      professional: {
        id: row.professional.profile_id,
        firstName: row.professional.first_name,
        lastName: row.professional.last_name,
        photoUrl: row.professional.photo_url,
      },
    }));
  }

  /**
   * Descarta el pedido de reseña de un turno propio. Idempotente: descartar
   * dos veces deja lo mismo. No impide reseñar después desde el detalle del
   * turno; solo deja de pedirlo.
   */
  async dismiss(patientId: string, appointmentId: string): Promise<void> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { patient_id: true },
    });
    // Ajeno o inexistente dan lo mismo: un 403 confirmaría que el turno existe.
    if (!appointment || appointment.patient_id !== patientId) {
      throw new NotFoundException('No encontramos ese turno.');
    }

    await this.prisma.reviewPromptDismissal.upsert({
      where: { appointment_id: appointmentId },
      create: { patient_id: patientId, appointment_id: appointmentId },
      update: {},
    });
  }
}
