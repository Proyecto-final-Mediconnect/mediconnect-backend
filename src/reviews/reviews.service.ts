import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateReviewDto } from './dto/create-review.dto';
import type { ModerateReviewDto } from './dto/moderate-review.dto';
import { isInappropriate } from './language-filter';

/** Cuántas reseñas por página, en el perfil y en la cola de moderación. */
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
  /** Por qué se rechazó, si se rechazó. */
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

/** Una reseña en la cola del moderador: con todo lo que hace falta para decidir. */
export interface ModerationReviewView {
  id: string;
  rating: number;
  comment: string | null;
  status: ReviewStatus;
  createdAt: string;
  patient: string;
  professional: { id: string; name: string };
  moderationReason: string | null;
  moderatedAt: string | null;
}

/** La respuesta pública de un profesional a una reseña (ENG-106). */
export interface ReviewResponseView {
  reviewId: string;
  content: string;
  createdAt: string;
}

export interface ModerationPage {
  reviews: ModerationReviewView[];
  page: number;
  hasMore: boolean;
}

/**
 * Reseñas de los profesionales (EP-02, Release 4): el paciente deja una por
 * consulta terminada (ENG-80), un moderador la aprueba o la rechaza (ENG-81) y
 * recién ahí se ve en el perfil y cuenta para el promedio (ENG-82).
 *
 * Todo va por Prisma: `reviews` tiene RLS activa sin políticas y sin permisos
 * para `anon` ni `authenticated`, así que las reglas de quién puede hacer qué
 * viven acá.
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deja la reseña de un turno propio y terminado. Una por turno: la tabla
   * tiene `appointment_id` único, y acá se contesta 409 antes de chocar con él.
   * Nace pendiente de moderación y no se ve hasta que se apruebe.
   */
  async create(
    patientId: string,
    appointmentId: string,
    dto: CreateReviewDto,
  ): Promise<MyReviewView> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        patient_id: true,
        professional_id: true,
        status: true,
        review: { select: { id: true } },
      },
    });
    // Ajeno o inexistente dan lo mismo: un 403 confirmaría que el turno existe.
    if (
      !appointment ||
      appointment.patient_id.toLowerCase() !== patientId.toLowerCase()
    ) {
      throw new NotFoundException('No encontramos ese turno.');
    }
    if (appointment.status !== 'COMPLETADO') {
      throw new ConflictException(
        'Solo se puede reseñar una consulta que ya se hizo.',
      );
    }
    if (appointment.review) {
      throw new ConflictException('Ya dejaste una reseña para esta consulta.');
    }
    // ENG-107: el filtro corre antes de guardar, y la reseña no llega a la cola.
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
   * No pasa por la cola de moderación: la escribe el profesional con nombre y
   * matrícula, sobre una reseña que un moderador ya aprobó. Sí pasa por el mismo
   * filtro de lenguaje que las reseñas (ENG-107), y queda en `audit_logs`.
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

    const row = await this.prisma.reviewResponse.upsert({
      where: { review_id: reviewId },
      create: {
        review_id: reviewId,
        professional_id: professionalId,
        content,
        created_at: now,
      },
      // La fecha que se muestra es la de la última versión.
      update: { content, created_at: now },
      select: { review_id: true, content: true, created_at: true },
    });

    await this.prisma.auditLog.create({
      data: {
        actor_id: professionalId,
        action: 'REVIEW_RESPONSE_SAVED',
        resource_type: 'review_responses',
        resource_id: reviewId,
        metadata: { length: content.length },
      },
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
    const { count } = await this.prisma.reviewResponse.deleteMany({
      where: { review_id: reviewId, professional_id: professionalId },
    });
    if (count === 0) {
      throw new NotFoundException('Esa reseña no tiene una respuesta tuya.');
    }
    await this.prisma.auditLog.create({
      data: {
        actor_id: professionalId,
        action: 'REVIEW_RESPONSE_DELETED',
        resource_type: 'review_responses',
        resource_id: reviewId,
      },
    });
  }

  /** La cola del moderador: las pendientes primero las más viejas, que esperan hace más. */
  async listForModeration(
    moderatorId: string,
    status: ReviewStatus,
    page: number,
  ): Promise<ModerationPage> {
    await this.assertModerator(moderatorId);
    const rows = await this.prisma.review.findMany({
      where: { status },
      orderBy:
        status === 'PENDIENTE_MODERACION'
          ? [{ created_at: 'asc' }, { id: 'asc' }]
          : [{ moderated_at: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * REVIEWS_PAGE_SIZE,
      take: REVIEWS_PAGE_SIZE + 1,
      select: MODERATION_SELECT,
    });
    return {
      reviews: rows.slice(0, REVIEWS_PAGE_SIZE).map(toModerationView),
      page,
      hasMore: rows.length > REVIEWS_PAGE_SIZE,
    };
  }

  /**
   * Aprueba o rechaza una reseña pendiente. Una sola vez: una reseña ya
   * moderada da 409, para que dos moderadores a la vez no se pisen. La
   * decisión queda en `audit_logs` y el paciente recibe un aviso.
   */
  async moderate(
    moderatorId: string,
    reviewId: string,
    dto: ModerateReviewDto,
    now: Date = new Date(),
  ): Promise<ModerationReviewView> {
    await this.assertModerator(moderatorId);

    // `updateMany` con el estado en el WHERE: es la única forma de que "solo si
    // sigue pendiente" sea atómico sin una transacción con lock.
    const { count } = await this.prisma.review.updateMany({
      where: { id: reviewId, status: 'PENDIENTE_MODERACION' },
      data: {
        status: dto.decision,
        moderator_id: moderatorId,
        moderation_reason: dto.reason ?? null,
        moderated_at: now,
      },
    });
    if (count === 0) {
      const existe = await this.prisma.review.findUnique({
        where: { id: reviewId },
        select: { id: true },
      });
      if (!existe) throw new NotFoundException('No encontramos esa reseña.');
      throw new ConflictException('Esa reseña ya fue moderada.');
    }

    const row = await this.prisma.review.findUniqueOrThrow({
      where: { id: reviewId },
      select: { ...MODERATION_SELECT, appointment_id: true, patient_id: true },
    });

    await this.prisma.auditLog.create({
      data: {
        actor_id: moderatorId,
        action: 'REVIEW_MODERATED',
        resource_type: 'reviews',
        resource_id: reviewId,
        metadata: { decision: dto.decision, reason: dto.reason ?? null },
      },
    });

    // El aviso no puede tirar abajo la moderación: ya está escrita.
    try {
      await this.prisma.notification.create({
        data: {
          user_id: row.patient_id,
          appointment_id: row.appointment_id,
          type: 'RESENA_MODERADA',
          channel: 'IN_APP',
          payload: {
            professional: fullName(
              row.professional.first_name,
              row.professional.last_name,
            ),
            decision: dto.decision,
            reason: dto.reason ?? null,
          },
          sent_at: now,
        },
      });
    } catch (err) {
      this.logger.error(
        `No se pudo avisar la moderación de ${reviewId}: ${String(err)}`,
      );
    }

    return toModerationView(row);
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

  /** Moderar es solo del rol MODERADOR, que vive en `profiles`, no en el JWT. */
  private async assertModerator(userId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (profile?.role !== 'MODERADOR') {
      throw new ForbiddenException('Solo un moderador puede moderar reseñas.');
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

const MODERATION_SELECT = {
  id: true,
  rating: true,
  comment: true,
  status: true,
  created_at: true,
  moderation_reason: true,
  moderated_at: true,
  patient: { select: { first_name: true, last_name: true } },
  professional: {
    select: { profile_id: true, first_name: true, last_name: true },
  },
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

function toModerationView(row: {
  id: string;
  rating: number;
  comment: string | null;
  status: ReviewStatus;
  created_at: Date;
  moderation_reason: string | null;
  moderated_at: Date | null;
  patient: { first_name: string; last_name: string };
  professional: { profile_id: string; first_name: string; last_name: string };
}): ModerationReviewView {
  return {
    id: row.id,
    rating: row.rating,
    comment: row.comment,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    patient: fullName(row.patient.first_name, row.patient.last_name),
    professional: {
      id: row.professional.profile_id,
      name: fullName(row.professional.first_name, row.professional.last_name),
    },
    moderationReason: row.moderation_reason,
    moderatedAt: row.moderated_at?.toISOString() ?? null,
  };
}

function fullName(first: string, last: string): string {
  return `${first} ${last}`.trim();
}

/** "Julián S.": en público alcanza para que se lea como una persona real. */
export function shortName(first: string, last: string): string {
  const inicial = last.trim().charAt(0);
  return inicial ? `${first.trim()} ${inicial.toUpperCase()}.` : first.trim();
}
