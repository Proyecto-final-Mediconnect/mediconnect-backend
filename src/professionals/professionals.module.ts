import { Module } from '@nestjs/common';
import { ProfessionalsController } from './professionals.controller';
import { ProfessionalsService } from './professionals.service';
import { SpecialtiesController } from './specialties.controller';

@Module({
  controllers: [ProfessionalsController, SpecialtiesController],
  providers: [ProfessionalsService],
})
export class ProfessionalsModule {}
