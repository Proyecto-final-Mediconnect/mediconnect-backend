import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateReviewDto } from './dto/create-review.dto';
import { containsContactInfo, isInappropriate } from './language-filter';
import { isReviewable } from './reviewable';

/** Cuántas reseñas por página en el perfil. */
export const REVIEWS_PAGE_SIZE = 10;

type ReviewStatus = 'PENDIENTE_MODERACION' | 'APROBADA' | 'RECHAZADA';

/** El promedio de un profesional. `null` cuando no tiene reseñas aprobadas. */
export interface RatingSummary {
  /** Con un decimal: 4.7. */
  average: number;
  count: number;
}

/** Una reseña propia, como la ve el paciente que la dejó. */
export interface MyReviewView {
  id: string;
  appointmentId: string;
  professionalId: string;
  rating: number;
  comment: string | null;
  status: ReviewStatus;
  /** Por qué se rechazó, si se rechazó (solo reseñas viejas: ya no se modera). */
  moderationReason: string | null;
  createdAt: string;
}

/** Una reseña aprobada en el perfil público. */
export interface PublicReviewView {
  id: string;
  rating: number;
  comment: string | null;
  /** "Julián S.": el nombre y la inicial, no el nombre completo. */
  author: string;
  createdAt: string;
  /** La respuesta del profesional, si la hay. */
  response: { content: string; createdAt: string } | null;
}

export interface PublicReviewPage {
  reviews: PublicReviewView[];
  rating: RatingSummary | null;
  page: number;
  hasMore: boolean;
}

/** La respuesta pública de un profesional a una reseña (ENG-106). */
export interface ReviewResponseView {
  reviewId: string;
  content: string;
  createdAt: string;
}

/**
 * Reseñas de los profesionales (EP-02, Release 4): el paciente deja una por
 * consulta terminada (ENG-80) y se publica en el acto: se ve en el perfil y
 * cuenta para el promedio (ENG-82). No hay moderación humana; lo que la
 * reemplaza es el filtro de lenguaje (ENG-107), que corre antes de guardar.
 *
 * Todo va por Prisma: `reviews` tiene RLS activa sin políticas y sin permisos
 * para `anon` ni `authenticated`, así que las reglas de quién puede hacer qué
 * viven acá.
 */
@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deja la reseña de un turno propio y terminado, o al que el paciente ya
   * entró (ENG-190, ver `isReviewable`). Una por turno: la tabla
   * tiene `appointment_id` único, y acá se contesta 409 antes de chocar con él.
   * Nace aprobada: no hay moderador, así que se publica en el acto.
   */
  async create(
    patientId: string,
    appointmentId: string,
    dto: CreateReviewDto,
    now: Date = new Date(),
  ): Promise<MyReviewView> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        patient_id: true,
        professional_id: true,
        status: true,
        scheduled_at: true,
        review: { select: { id: true } },
        consultation: {
          select: { patient_joined_at: true, professional_joined_at: true },
        },
      },
    });
    // Ajeno o inexistente dan lo mismo: un 403 confirmaría que el turno existe.
    if (
      !appointment ||
      appointment.patient_id.toLowerCase() !== patientId.toLowerCase()
    ) {
      throw new NotFoundException('No encontramos ese turno.');
    }
    if (!isReviewable(appointment, now)) {
      throw new ConflictException(
        'Solo se puede reseñar una consulta que ya se hizo.',
      );
    }
    if (appointment.review) {
      throw new ConflictException('Ya dejaste una reseña para esta consulta.');
    }
    // ENG-107: el filtro corre antes de guardar, y la reseña no se publica.
    // Se le pide al paciente que la reformule en lugar de rechazarla después:
    // es una por turno, y un rechazo lo dejaría sin poder opinar.
    if (dto.comment && isInappropriate(dto.comment)) {
      throw new UnprocessableEntityException(
        'Tu comentario tiene palabras que no podemos publicar. Reformulalo sin insultos: las críticas son bienvenidas.',
      );
    }

    try {
      const row = await this.prisma.review.create({
        data: {
          patient_id: appointment.patient_id,
          professional_id: appointment.professional_id,
          appointment_id: appointmentId,
          rating: dto.rating,
          comment: dto.comment ?? null,
          // Explícito: el default de la columna sigue siendo PENDIENTE_MODERACION.
          status: 'APROBADA',
        },
        select: MY_SELECT,
      });
      return toMyView(row);
    } catch (err) {
      // Dos envíos a la vez: el segundo choca con el índice único.
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(
          'Ya dejaste una reseña para esta consulta.',
        );
      }
      throw err;
    }
  }

  /** Las reseñas que dejó el paciente, de la más nueva a la más vieja. */
  async listMine(patientId: string): Promise<MyReviewView[]> {
    const rows = await this.prisma.review.findMany({
      where: { patient_id: patientId },
      select: MY_SELECT,
      orderBy: { created_at: 'desc' },
    });
    return rows.map(toMyView);
  }

  /**
   * Promedio y cantidad de reseñas aprobadas de cada profesional pedido. El
   * catálogo lo pide para una página entera de una vez.
   */
  async ratingSummaries(
    professionalIds: string[],
  ): Promise<Map<string, RatingSummary>> {
    if (professionalIds.length === 0) return new Map();
    const grupos = await this.prisma.review.groupBy({
      by: ['professional_id'],
      where: { professional_id: { in: professionalIds }, status: 'APROBADA' },
      _avg: { rating: true },
      _count: { _all: true },
    });
    return new Map(
      grupos.map((g) => [
        g.professional_id,
        {
          average: Math.round((g._avg.rating ?? 0) * 10) / 10,
          count: g._count._all,
        },
      ]),
    );
  }

  /** Las reseñas aprobadas de un profesional, con su promedio. Es público. */
  async listApproved(
    professionalId: string,
    page: number,
  ): Promise<PublicReviewPage> {
    const where = {
      professional_id: professionalId,
      status: 'APROBADA' as const,
    };
    const [rows, resumen] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * REVIEWS_PAGE_SIZE,
        // Uno de más para saber si hay otra página sin contar todo.
        take: REVIEWS_PAGE_SIZE + 1,
        select: {
          id: true,
          rating: true,
          comment: true,
          created_at: true,
          patient: { select: { first_name: true, last_name: true } },
          response: { select: { content: true, created_at: true } },
        },
      }),
      this.ratingSummaries([professionalId]),
    ]);

    return {
      reviews: rows.slice(0, REVIEWS_PAGE_SIZE).map((row) => ({
        id: row.id,
        rating: row.rating,
        comment: row.comment,
        author: shortName(row.patient.first_name, row.patient.last_name),
        createdAt: row.created_at.toISOString(),
        response: row.response
          ? {
              content: row.response.content,
              createdAt: row.response.created_at.toISOString(),
            }
          : null,
      })),
      rating: resumen.get(professionalId) ?? null,
      page,
      hasMore: rows.length > REVIEWS_PAGE_SIZE,
    };
  }

  /**
   * Las reseñas aprobadas que recibió el profesional, con su promedio y sus
   * respuestas (ENG-106). Son las mismas que ve cualquiera en su perfil: las
   * pendientes y las rechazadas no, porque no hay nada que responder en público.
   */
  async listReceived(
    professionalId: string,
    page: number,
  ): Promise<PublicReviewPage> {
    await this.assertProfessional(professionalId);
    return this.listApproved(professionalId, page);
  }

  /**
   * Responde en público una reseña aprobada propia, o cambia la respuesta que ya
   * tenía (ENG-106). Una sola por reseña.
   *
   * La escribe el profesional con nombre y matrícula, sobre una reseña ya
   * publicada. Pasa por el mismo filtro de lenguaje que las reseñas (ENG-107),
   * y queda en `audit_logs`.
   */
  async respond(
    professionalId: string,
    reviewId: string,
    content: string,
    now: Date = new Date(),
  ): Promise<ReviewResponseView> {
    await this.assertProfessional(professionalId);
    await this.assertOwnApprovedReview(professionalId, reviewId);
    if (isInappropriate(content)) {
      throw new UnprocessableEntityException(
        'Tu respuesta tiene palabras que no podemos publicar. Reformulala, por favor.',
      );
    }

    if (containsContactInfo(content)) {
      throw new UnprocessableEntityException(
        'Tu respuesta no puede incluir links, mails ni teléfonos.',
      );
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const previa = await tx.reviewResponse.findUnique({
        where: { review_id: reviewId },
        select: { content: true },
      });
      const saved = await tx.reviewResponse.upsert({
        where: { review_id: reviewId },
        create: {
          review_id: reviewId,
          professional_id: professionalId,
          content,
          created_at: now,
        },
        // Se conserva la fecha de la primera versión (no hay updated_at).
        update: { content },
        select: { review_id: true, content: true, created_at: true },
      });
      await tx.auditLog.create({
        data: {
          actor_id: professionalId,
          action: 'REVIEW_RESPONSE_SAVED',
          resource_type: 'review_responses',
          resource_id: reviewId,
          metadata: {
            length: content.length,
            previousContent: previa?.content ?? null,
          },
        },
      });
      return saved;
    });

    return {
      reviewId: row.review_id,
      content: row.content,
      createdAt: row.created_at.toISOString(),
    };
  }

  /** Borra la respuesta propia a una reseña (ENG-106). Sin respuesta, 404. */
  async deleteResponse(
    professionalId: string,
    reviewId: string,
  ): Promise<void> {
    await this.assertProfessional(professionalId);
    await this.prisma.$transaction(async (tx) => {
      const previa = await tx.reviewResponse.findFirst({
        where: { review_id: reviewId, professional_id: professionalId },
        select: { content: true },
      });
      const { count } = await tx.reviewResponse.deleteMany({
        where: { review_id: reviewId, professional_id: professionalId },
      });
      if (count === 0) {
        throw new NotFoundException('Esa reseña no tiene una respuesta tuya.');
      }
      await tx.auditLog.create({
        data: {
          actor_id: professionalId,
          action: 'REVIEW_RESPONSE_DELETED',
          resource_type: 'review_responses',
          resource_id: reviewId,
          metadata: { previousContent: previa?.content ?? null },
        },
      });
    });
  }

  /** Responder es del rol PROFESIONAL, que vive en `profiles`, no en el JWT. */
  private async assertProfessional(userId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (profile?.role !== 'PROFESIONAL') {
      throw new ForbiddenException(
        'Solo un profesional puede responder reseñas.',
      );
    }
  }

  /**
   * La reseña es del profesional y está aprobada. Ajena o inexistente dan el
   * mismo 404: un 403 confirmaría que existe.
   */
  private async assertOwnApprovedReview(
    professionalId: string,
    reviewId: string,
  ): Promise<void> {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { professional_id: true, status: true },
    });
    if (
      !review ||
      review.professional_id.toLowerCase() !== professionalId.toLowerCase()
    ) {
      throw new NotFoundException('No encontramos esa reseña.');
    }
    if (review.status !== 'APROBADA') {
      throw new ConflictException(
        'Solo se puede responder una reseña publicada.',
      );
    }
  }
}

const MY_SELECT = {
  id: true,
  appointment_id: true,
  professional_id: true,
  rating: true,
  comment: true,
  status: true,
  moderation_reason: true,
  created_at: true,
} as const;

function toMyView(row: {
  id: string;
  appointment_id: string;
  professional_id: string;
  rating: number;
  comment: string | null;
  status: ReviewStatus;
  moderation_reason: string | null;
  created_at: Date;
}): MyReviewView {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    professionalId: row.professional_id,
    rating: row.rating,
    comment: row.comment,
    status: row.status,
    moderationReason: row.status === 'RECHAZADA' ? row.moderation_reason : null,
    createdAt: row.created_at.toISOString(),
  };
}

/** "Julián S.": en público alcanza para que se lea como una persona real. */
export function shortName(first: string, last: string): string {
  const inicial = last.trim().charAt(0);
  return inicial ? `${first.trim()} ${inicial.toUpperCase()}.` : first.trim();
}
