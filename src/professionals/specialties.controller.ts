import { Controller, Get } from '@nestjs/common';
import { ProfessionalsService } from './professionals.service';

/** Catálogo curado de especialidades. Público: lo consumen el formulario de
 *  perfil profesional (ENG-48) y el filtro del catálogo (EP-02) — fuente única. */
@Controller('specialties')
export class SpecialtiesController {
  constructor(private readonly professionals: ProfessionalsService) {}

  @Get()
  list() {
    return this.professionals.listSpecialties();
  }
}
