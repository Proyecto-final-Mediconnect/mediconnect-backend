import { Module } from '@nestjs/common';
import { ProfessionalsController } from './professionals.controller';
import { ProfessionalsService } from './professionals.service';
import { PublicProfessionalsController } from './public-professionals.controller';
import { PublicProfessionalsService } from './public-professionals.service';
import { SpecialtiesController } from './specialties.controller';

@Module({
  // ProfessionalsController va primero: sus rutas estáticas `/me` se registran
  // antes que `professionals/:id` del controller público, evitando que "me"
  // sea interpretado como un id.
  controllers: [
    ProfessionalsController,
    SpecialtiesController,
    PublicProfessionalsController,
  ],
  providers: [ProfessionalsService, PublicProfessionalsService],
})
export class ProfessionalsModule {}
