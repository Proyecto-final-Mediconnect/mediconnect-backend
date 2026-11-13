import { Module } from '@nestjs/common';
import {
  PublicReviewsController,
  ReviewsController,
} from './reviews.controller';
import { ReviewPromptsService } from './review-prompts.service';
import { ReviewsService } from './reviews.service';

/**
 * Reseñas (EP-02, Release 4): dejar (ENG-80), moderar (ENG-81) y mostrar las
 * aprobadas con su promedio en el perfil y en el catálogo (ENG-82), y pedirlas
 * al terminar la consulta (ENG-190).
 */
@Module({
  controllers: [ReviewsController, PublicReviewsController],
  providers: [ReviewsService, ReviewPromptsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
