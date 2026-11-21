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
import { AppointmentClosingService } from './appointment-closing.service';
import { AppointmentsService } from './appointments.service';
import { CancelByProfessionalDto } from './dto/cancel-by-professional.dto';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { ProfessionalCancellationService } from './professional-cancellation.service';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';

/** Turnos del usuario autenticado (ENG-54). */
@Controller('appointments')
@UseGuards(JwtAuthGuard)
export class AppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly closing: AppointmentClosingService,
    private readonly professionalCancellation: ProfessionalCancellationService,
  ) {}

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
   * El profesional cancela un turno futuro propio, con un motivo obligatorio
   * (ENG-204, ADR-018). Si estaba pagado queda `A_REPROGRAMAR` y el paciente
   * elige otro horario o el reembolso del 100 %; si era una reserva sin pagar,
   * queda `CANCELADO`. Las reglas están en `ProfessionalCancellationService`.
   */
  @Patch(':id/cancel-by-professional')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  cancelByProfessional(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CancelByProfessionalDto,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.professionalCancellation.cancelByProfessional(
      accessToken,
      userId,
      id,
      dto.reason,
    );
  }

  /**
   * El paciente elige el reembolso del 100 % de un turno que el profesional
   * canceló (ENG-204, ADR-018). Sin body: no hay nada que elegir más que eso.
   */
  @Patch(':id/full-refund')
  requestFullRefund(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.professionalCancellation.requestFullRefund(
      accessToken,
      userId,
      id,
    );
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

  /**
   * El profesional finaliza la consulta (ENG-189): el turno queda `COMPLETADO`
   * y el paciente ya puede reseñarlo. Idempotente. Las reglas están en
   * `AppointmentClosingService.complete`.
   */
  @Patch(':id/complete')
  complete(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.closing.complete(accessToken, userId, id);
  }

  /**
   * El profesional marca que el paciente no se presentó (ENG-189). No
   * reembolsa. Idempotente.
   */
  @Patch(':id/no-show')
  markNoShow(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.closing.markNoShow(accessToken, userId, id);
  }
}
