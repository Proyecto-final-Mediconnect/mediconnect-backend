import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AppointmentsService } from './appointments.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';

/**
 * Disponibilidad pública de un profesional (ENG-54).
 *
 * Va en un controller aparte del de turnos porque el recurso es otro: acá se lee
 * la agenda de **otro** profesional, mientras que `/appointments` opera sobre los
 * turnos propios. Y cuelga de `professionals/:id/...` y no de
 * `professionals/me/schedule` (ENG-53) porque eso último es la agenda propia en
 * crudo — franjas y bloqueos editables— y esto es la grilla ya resuelta que ve un
 * paciente.
 *
 * Pide sesión: la historia de usuario es "como paciente **autenticado**". Además
 * evita que los horarios de todos los profesionales sean raspables sin cuenta.
 */
@Controller('professionals/:professionalId/availability')
@UseGuards(JwtAuthGuard)
export class AvailabilityController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  getAvailability(
    @Param('professionalId', new ParseUUIDPipe({ version: '4' }))
    professionalId: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.appointments.getAvailability(professionalId, query);
  }
}
