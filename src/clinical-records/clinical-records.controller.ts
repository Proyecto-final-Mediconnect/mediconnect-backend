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
   * ve su historia completa (`..._select_own_patient`, ENG-57), el profesional ve
   * lo que firmó (`..._select_own_authored`, ENG-58) y, desde ENG-60, el
   * profesional con un turno no cancelado con ese paciente ve la HC **completa**,
   * incluidas las entradas de otros profesionales.
   *
   * **ENG-60 cambió el 404-por-omisión de ENG-58 por un 403 explícito.** Este
   * endpoint devolvía `[]` a quien no podía ver nada, para no confirmarle a un
   * tercero que ese paciente tiene historia clínica. El criterio de aceptación de
   * ENG-60 pide 403 sin relación vigente y esa es la decisión que se tomó: el
   * profesional que se equivoca de paciente merece un error claro, no una HC
   * vacía que parece un paciente sin historia. Se asume el costo de revelar que
   * el UUID corresponde a un paciente real.
   *
   * Una HC realmente vacía sigue devolviendo `[]` con 200.
   *
   * Cada lectura deja registro en `audit_logs` (Ley 26.529): quién, de quién y
   * cuándo. Si no se puede registrar, no se devuelve la historia.
   */
  @Get()
  list(
    @Req() req: Request,
    @Param('patientId', new ParseUUIDPipe({ version: '4' }))
    patientId: string,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.records.readPatientRecord(userId, accessToken, patientId);
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
