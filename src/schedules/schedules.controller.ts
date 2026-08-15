import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { CreateScheduleBlockDto } from './dto/create-schedule-block.dto';
import { SaveScheduleDto } from './dto/save-schedule.dto';
import { SchedulesService } from './schedules.service';

/**
 * Agenda semanal del profesional autenticado (ENG-53).
 *
 * Cuelga de `professionals/me` porque el recurso es la agenda *propia*: no hay
 * forma de pedir la de otro por acá. La lectura pública de disponibilidad, que
 * necesita ENG-54 para el calendario de reserva, va a ser un endpoint aparte con
 * sus propias reglas de RLS.
 */
@Controller('professionals/me/schedule')
@UseGuards(JwtAuthGuard)
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  getMySchedule(@Req() req: Request) {
    const { userId, accessToken } = requireAuth(req);
    return this.schedules.getMySchedule(accessToken, userId);
  }

  /** PUT y no PATCH: el cuerpo es la agenda semanal completa y reemplaza a la
   *  anterior. Es idempotente, que es justo lo que se quiere si el profesional
   *  toca "Guardar" dos veces. */
  @Put()
  saveMyRules(@Req() req: Request, @Body() dto: SaveScheduleDto) {
    const { userId, accessToken } = requireAuth(req);
    return this.schedules.saveMyRules(accessToken, userId, dto);
  }

  @Post('blocks')
  @HttpCode(HttpStatus.CREATED)
  createBlock(@Req() req: Request, @Body() dto: CreateScheduleBlockDto) {
    const { userId, accessToken } = requireAuth(req);
    return this.schedules.createBlock(accessToken, userId, dto);
  }

  @Delete('blocks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteBlock(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) blockId: string,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.schedules.deleteBlock(accessToken, userId, blockId);
  }
}
