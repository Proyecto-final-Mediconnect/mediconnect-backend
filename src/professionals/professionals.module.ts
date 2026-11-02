import { Module } from '@nestjs/common';
import { CancellationPolicyService } from './cancellation-policy.service';
import { ProfessionalsController } from './professionals.controller';
import { ProfessionalsService } from './professionals.service';
import { PublicProfessionalsController } from './public-professionals.controller';
import { PublicProfessionalsService } from './public-professionals.service';
import { SpecialtiesController } from './specialties.controller';
import { ReviewsModule } from '../reviews/reviews.module';

@Module({
  // El promedio de reseñas del perfil público (ENG-82).
  imports: [ReviewsModule],
  // ProfessionalsController va primero: sus rutas estáticas `/me` se registran
  // antes que `professionals/:id` del controller público, evitando que "me"
  // sea interpretado como un id.
  controllers: [
    ProfessionalsController,
    SpecialtiesController,
    PublicProfessionalsController,
  ],
  providers: [
    ProfessionalsService,
    PublicProfessionalsService,
    CancellationPolicyService,
  ],
  // ENG-65 (reembolsos) necesita la política para saber cuánto devolver.
  exports: [CancellationPolicyService],
})
export class ProfessionalsModule {}
