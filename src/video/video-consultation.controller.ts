import {
  Controller,
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
import { VideoConsultationService } from './video-consultation.service';

/**
 * Videoconsulta de un turno (ENG-56).
 *
 * Cuelga de `/appointments/:appointmentId/video` y no de `/video/...` porque el
 * recurso es el turno: no existe una sala que no sea la de un turno. Esa es
 * justamente la diferencia con los endpoints del spike (`/video/spike`), que sí
 * crean salas sueltas y se borran cuando ENG-51 termine de tomar sus métricas.
 *
 * El controller vive igual dentro de `VideoModule` porque lo que hace es hablar
 * con Daily; `AppointmentsModule` no tiene por qué enterarse de que existe un
 * proveedor de video.
 */
@Controller('appointments/:appointmentId/video')
@UseGuards(JwtAuthGuard)
export class VideoConsultationController {
  constructor(private readonly consultations: VideoConsultationService) {}

  /**
   * Entra a la sala del turno y devuelve la URL con el meeting token.
   *
   * `POST` y no `GET` aunque parezca una lectura: la primera llamada **crea** la
   * consulta, la sesión de video y la sala en Daily. No es idempotente en el
   * sentido de HTTP (la primera vez cambia el estado del sistema) y no debe
   * quedar cacheada por nadie — la URL que devuelve lleva una credencial
   * adentro.
   *
   * Rate limit igual de ajustado que en el spike y por el mismo motivo: cada
   * primera llamada puede crear una sala, y crear salas cuesta plata. 10/min deja
   * lugar a recargar la página o a reconectarse tras un corte, y no a mucho más.
   */
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  join(
    @Req() req: Request,
    @Param('appointmentId', new ParseUUIDPipe({ version: '4' }))
    appointmentId: string,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.consultations.join(accessToken, userId, appointmentId);
  }
}
