import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';

/** Turnos del usuario autenticado (ENG-54). */
@Controller('appointments')
@UseGuards(JwtAuthGuard)
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  /**
   * Reserva un turno. Rate limit más ajustado que el default de 60/min: cada
   * intento toca la agenda de un profesional, y no hay ningún uso legítimo que
   * necesite reservar diez turnos por minuto. Acota además el barrido de horarios
   * a fuerza de reintentos.
   */
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  book(@Req() req: Request, @Body() dto: CreateAppointmentDto) {
    const { userId, accessToken } = requireAuth(req);
    return this.appointments.book(accessToken, userId, dto);
  }

  /**
   * Turnos propios. Sirve a los dos roles sin ramificar: RLS devuelve aquellos en
   * los que el usuario es el paciente o el profesional. La pantalla completa de
   * "Mis turnos" es ENG-55; este endpoint es el dato que consume.
   */
  @Get('me')
  listMine(@Req() req: Request) {
    const { userId, accessToken } = requireAuth(req);
    return this.appointments.listMine(accessToken, userId);
  }
}
