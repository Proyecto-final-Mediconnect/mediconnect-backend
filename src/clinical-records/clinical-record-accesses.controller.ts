import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { ClinicalRecordAccessesService } from './clinical-record-accesses.service';
import { ClinicalRecordAccessesQueryDto } from './dto/clinical-record-accesses-query.dto';

@Controller('patients/me/clinical-record/accesses')
@UseGuards(JwtAuthGuard)
export class ClinicalRecordAccessesController {
  constructor(private readonly accesses: ClinicalRecordAccessesService) {}

  /**
   * Quién abrió mi historia clínica (ENG-165), del más reciente al más viejo y
   * de a 10. Solo los accesos de profesionales: las lecturas del propio
   * paciente no se listan. El id sale del JWT, no de la ruta.
   */
  @Get()
  listMyAccesses(
    @Req() req: Request,
    @Query() query: ClinicalRecordAccessesQueryDto,
  ) {
    const { userId } = requireAuth(req);
    return this.accesses.listMyAccesses(userId, query.pagina);
  }
}
