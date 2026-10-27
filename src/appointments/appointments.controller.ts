import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';

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

  /**
   * Cuánto se devolvería si el paciente cancela ahora (ENG-65), para mostrarlo
   * antes de confirmar. No cancela nada.
   */
  @Get(':id/cancellation-quote')
  cancellationQuote(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.appointments.cancellationQuote(accessToken, userId, id);
  }

  /**
   * Cancela un turno futuro propio (ENG-55).
   *
   * `PATCH` y no `DELETE`: el turno no se borra. Queda en CANCELADO, con su
   * `cancelled_at`, porque el profesional tiene que poder ver que le cancelaron
   * y porque de esa fila cuelgan el pago (ENG-63) y el reembolso (ENG-65).
   *
   * Sin body: lo único que se puede pedir es la cancelación. El motivo
   * (`appointments.cancellation_reason`) no se expone todavía — el criterio de
   * aceptación no lo pide y con `forbidNonWhitelisted` mandarlo daría 400.
   */
  @Patch(':id/cancel')
  cancel(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.appointments.cancel(accessToken, userId, id);
  }

  /**
   * Mueve un turno futuro propio a otro horario del mismo profesional (ENG-66).
   * Es el mismo turno, con el mismo pago: no se vuelve a cobrar. Las reglas
   * están en `AppointmentsService.reschedule`.
   */
  @Patch(':id/reschedule')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reschedule(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RescheduleAppointmentDto,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.appointments.reschedule(accessToken, userId, id, dto);
  }
}
