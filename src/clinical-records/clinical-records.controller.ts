import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { ClinicalRecordsService } from './clinical-records.service';
import { CreateClinicalEntryDto } from './dto/create-clinical-entry.dto';

/**
 * Historia clínica de un paciente (ENG-58).
 *
 * Cuelga del paciente porque la HC **es del paciente**, no de la consulta ni del
 * turno: eso es lo que dice la Ley 26.529 y es lo que hace que el mismo recurso
 * sirva para las cuatro historias que lo van a consumir. Una entrada puede
 * referenciar la consulta que la originó (`consultationId`), pero la consulta no
 * es su dueña.
 */
@Controller('patients/:patientId/clinical-record')
@UseGuards(JwtAuthGuard)
export class ClinicalRecordsController {
  constructor(private readonly records: ClinicalRecordsService) {}

  /**
   * Entradas de la HC del paciente, de la más vieja a la más nueva.
   *
   * Un solo endpoint para los dos roles: **RLS decide qué devuelve**. El paciente
   * ve su historia completa (`..._select_own_patient`, ENG-57) y el profesional ve
   * las entradas que él firmó (`..._select_own_authored`, ENG-58). Si ENG-60
   * decide ampliar el acceso del profesional, agrega su política y este endpoint
   * empieza a devolver más sin cambiar una línea.
   *
   * Devuelve `[]` —no 403— cuando el usuario no puede ver nada de esa HC: para él
   * esas filas no existen, y distinguir "vacía" de "no te la puedo mostrar"
   * confirmaría que ese paciente tiene historia clínica.
   */
  @Get()
  list(
    @Req() req: Request,
    @Param('patientId', new ParseUUIDPipe({ version: '4' }))
    patientId: string,
  ) {
    const { accessToken } = requireAuth(req);
    return this.records.listForPatient(accessToken, patientId);
  }

  /**
   * Agrega una entrada firmada por el profesional autenticado.
   *
   * El `professionalId` sale del JWT y nunca del cuerpo: es la autoría del
   * asiento clínico y entra a la preimagen del hash.
   *
   * Rate limit ajustado. No es por costo como en videoconsulta: es porque cada
   * request agrega una fila **que no se puede borrar**. Un cliente en loop dejaría
   * basura permanente en la historia clínica de un paciente.
   */
  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  add(
    @Req() req: Request,
    @Param('patientId', new ParseUUIDPipe({ version: '4' }))
    patientId: string,
    @Body() dto: CreateClinicalEntryDto,
  ) {
    const { userId } = requireAuth(req);
    return this.records.addEntryAsProfessional(userId, patientId, dto);
  }
}
