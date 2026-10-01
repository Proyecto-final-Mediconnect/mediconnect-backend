import {
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
import { AppointmentPaymentService } from './appointment-payment.service';

/**
 * Pago del turno (ENG-63).
 *
 * Cuelga del turno y no de `/payments` porque no existe un pago que no sea el de
 * un turno: el recurso es la reserva, y el cobro es una acción sobre ella. Es el
 * mismo criterio que `/appointments/:id/video` en ENG-56.
 *
 * El webhook de ENG-64 vive aparte y es **público**: MercadoPago no tiene un JWT
 * nuestro. Estos dos endpoints, en cambio, son del paciente y van con sesión.
 */
@Controller('appointments/:appointmentId/payment')
@UseGuards(JwtAuthGuard)
export class AppointmentPaymentController {
  constructor(private readonly payments: AppointmentPaymentService) {}

  /**
   * Devuelve el link de Checkout Pro del turno, creándolo la primera vez.
   *
   * `POST` porque la primera llamada crea la preferencia en MercadoPago y la
   * fila en `payments`. Es idempotente igual —misma clave, misma preferencia—
   * pero no es una lectura y no debe quedar cacheada.
   *
   * Rate limit ajustado: cada llamada habla con un proveedor externo y toca una
   * fila de dinero. 10/min deja lugar a reintentar tras un corte y a poco más.
   */
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  checkout(
    @Req() req: Request,
    @Param('appointmentId', new ParseUUIDPipe({ version: '4' }))
    appointmentId: string,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.payments.createCheckout(accessToken, userId, appointmentId);
  }

  /**
   * Estado del pago, para la pantalla a la que vuelve el paciente.
   *
   * Es una lectura y se puede pollear: la pantalla de vuelta no sabe si el
   * webhook ya llegó —MercadoPago redirige antes de notificar— así que consulta
   * hasta que el estado se mueva.
   */
  @Get()
  status(
    @Req() req: Request,
    @Param('appointmentId', new ParseUUIDPipe({ version: '4' }))
    appointmentId: string,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.payments.readStatus(accessToken, userId, appointmentId);
  }
}
