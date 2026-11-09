import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { CreateReviewDto } from './dto/create-review.dto';
import { ModerateReviewDto } from './dto/moderate-review.dto';
import { ReviewResponseDto } from './dto/review-response.dto';
import {
  ModerationQueryDto,
  ReviewPageQueryDto,
} from './dto/review-list-query.dto';
import { ReviewPromptsService } from './review-prompts.service';
import { ReviewsService } from './reviews.service';

/** Dejar una reseña (ENG-80) y ver las propias. */
@Controller()
@UseGuards(JwtAuthGuard)
export class ReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly prompts: ReviewPromptsService,
  ) {}

  /** La reseña de la consulta de un turno propio y terminado. Una por turno. */
  @Post('appointments/:appointmentId/review')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  create(
    @Req() req: Request,
    @Param('appointmentId', new ParseUUIDPipe({ version: '4' }))
    appointmentId: string,
    @Body() dto: CreateReviewDto,
  ) {
    const { userId } = requireAuth(req);
    return this.reviews.create(userId, appointmentId, dto);
  }

  /** Las que dejó el paciente: "Mis turnos" las usa para saber qué falta reseñar. */
  @Get('reviews/me')
  listMine(@Req() req: Request) {
    const { userId } = requireAuth(req);
    return this.reviews.listMine(userId);
  }

  /**
   * Turnos que el paciente puede reseñar y todavía no reseñó ni descartó: la
   * tarjeta "¿Cómo fue tu consulta?" del inicio (ENG-190).
   */
  @Get('reviews/pending')
  listPending(@Req() req: Request) {
    const { userId } = requireAuth(req);
    return this.prompts.listPending(userId);
  }

  /** Descarta la tarjeta de un turno: no vuelve en ningún dispositivo (ENG-190). */
  @Post('reviews/pending/:appointmentId/dismiss')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async dismiss(
    @Req() req: Request,
    @Param('appointmentId', new ParseUUIDPipe({ version: '4' }))
    appointmentId: string,
  ): Promise<void> {
    const { userId } = requireAuth(req);
    await this.prompts.dismiss(userId, appointmentId);
  }

  /** Las reseñas publicadas que recibió el profesional, con sus respuestas (ENG-106). */
  @Get('reviews/received')
  listReceived(@Req() req: Request, @Query() query: ReviewPageQueryDto) {
    const { userId } = requireAuth(req);
    return this.reviews.listReceived(userId, query.page);
  }

  /**
   * Responde en público una reseña propia, o cambia la respuesta (ENG-106).
   * `PUT` porque hay una sola por reseña: repetirlo deja el mismo resultado.
   */
  @Put('reviews/:reviewId/response')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  respond(
    @Req() req: Request,
    @Param('reviewId', new ParseUUIDPipe({ version: '4' })) reviewId: string,
    @Body() dto: ReviewResponseDto,
  ) {
    const { userId } = requireAuth(req);
    return this.reviews.respond(userId, reviewId, dto.content);
  }

  /** Borra la respuesta propia a una reseña (ENG-106). */
  @Delete('reviews/:reviewId/response')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteResponse(
    @Req() req: Request,
    @Param('reviewId', new ParseUUIDPipe({ version: '4' })) reviewId: string,
  ): Promise<void> {
    const { userId } = requireAuth(req);
    await this.reviews.deleteResponse(userId, reviewId);
  }

  /** La cola de moderación (ENG-81). Solo para el rol MODERADOR. */
  @Get('moderation/reviews')
  listForModeration(@Req() req: Request, @Query() query: ModerationQueryDto) {
    const { userId } = requireAuth(req);
    return this.reviews.listForModeration(userId, query.status, query.page);
  }

  /** Aprobar o rechazar (con motivo) una reseña pendiente. */
  @Patch('moderation/reviews/:reviewId')
  moderate(
    @Req() req: Request,
    @Param('reviewId', new ParseUUIDPipe({ version: '4' })) reviewId: string,
    @Body() dto: ModerateReviewDto,
  ) {
    const { userId } = requireAuth(req);
    return this.reviews.moderate(userId, reviewId, dto);
  }
}

/** Las reseñas aprobadas de un profesional (ENG-82). Público, como su perfil. */
@Controller('professionals')
export class PublicReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get(':id/reviews')
  list(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: ReviewPageQueryDto,
  ) {
    return this.reviews.listApproved(id, query.page);
  }
}
