import { Module } from '@nestjs/common';
import {
  PublicReviewsController,
  ReviewsController,
} from './reviews.controller';
import { ReviewsService } from './reviews.service';

/**
 * Reseñas (EP-02, Release 4): dejar (ENG-80), moderar (ENG-81) y mostrar las
 * aprobadas con su promedio en el perfil y en el catálogo (ENG-82).
 */
@Module({
  controllers: [ReviewsController, PublicReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
