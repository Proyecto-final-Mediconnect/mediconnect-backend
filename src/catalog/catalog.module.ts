import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { ReviewsModule } from '../reviews/reviews.module';

@Module({
  // El promedio de reseñas de cada tarjeta (ENG-82).
  imports: [ReviewsModule],
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}
