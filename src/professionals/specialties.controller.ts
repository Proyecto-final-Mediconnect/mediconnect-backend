import { Controller, Get } from '@nestjs/common';
import { ProfessionalsService } from './professionals.service';
import { SkipLegal } from '../legal/skip-legal.decorator';

/** Catálogo curado de especialidades. Público: lo consumen el formulario de
 *  perfil profesional (ENG-48) y el filtro del catálogo (EP-02) — fuente única. */
// Pública: sin usuario no hay consentimiento que exigir (ENG-140).
@SkipLegal()
@Controller('specialties')
export class SpecialtiesController {
  constructor(private readonly professionals: ProfessionalsService) {}

  @Get()
  list() {
    return this.professionals.listSpecialties();
  }
}
