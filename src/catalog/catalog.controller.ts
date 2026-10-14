import { Controller, Get, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { ListProfessionalsQueryDto } from './dto/list-professionals-query.dto';
import { SkipLegal } from '../legal/skip-legal.decorator';

/**
 * Catálogo público (ENG-49). Sin `JwtAuthGuard` a propósito: buscar
 * profesionales no requiere autenticación. Por eso el service expone solo
 * profesionales VALIDADO y un subconjunto acotado de campos.
 *
 * El listado de especialidades para el filtro NO vive acá: ya lo expone
 * `GET /specialties` (SpecialtiesController, ENG-48) y es fuente única.
 */
// Pública: sin usuario no hay consentimiento que exigir (ENG-140).
@SkipLegal()
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('professionals')
  listProfessionals(@Query() query: ListProfessionalsQueryDto) {
    return this.catalogService.listProfessionals(query);
  }
}
