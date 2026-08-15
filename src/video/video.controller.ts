import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DailyService } from './daily.service';
import { SpikeRoomNamePipe } from './dto/spike-room-name.pipe';

/**
 * `JwtAuthGuard` garantiza `user`; esto lo hace explícito para TypeScript sin
 * repartir `!` por los handlers. Es la misma función que
 * `professionals.controller.ts` define localmente; ENG-53 la está extrayendo a
 * `common/http/require-auth.ts` y este módulo va a pasar a importarla de ahí
 * cuando esa rama mergee. Duplicar el helper acá evita que dos PRs en revisión
 * peleen por el mismo archivo nuevo.
 */
function requireUserId(req: Request): string {
  if (!req.user?.id) {
    throw new UnauthorizedException('No se encontró un token de sesión.');
  }
  return req.user.id;
}

/**
 * Endpoints del spike de Daily.co (ENG-51).
 *
 * Cuelgan de `/video/spike` y no de `/video` a propósito: **no son la API de
 * videoconsulta**. La real (crear la sala al confirmarse un turno, asociarla a
 * `video_sessions`, dar acceso solo al paciente y al profesional de ese turno)
 * es ENG-56. Estos existen para poder ejecutar y repetir la medición del spike,
 * y el prefijo deja claro que se borran cuando ENG-56 esté implementado.
 *
 * Todos piden sesión: crear salas cuesta dinero (Daily factura por minuto de
 * participante) y un endpoint abierto sería una factura abierta.
 */
@Controller('video/spike')
@UseGuards(JwtAuthGuard)
export class VideoController {
  constructor(private readonly daily: DailyService) {}

  /**
   * Crea una sala privada de prueba y devuelve las dos URLs tokenizadas.
   *
   * Rate limit agresivo (5/min contra el default de 60): cada sala creada es
   * potencialmente plata, y no hay ningún caso de uso legítimo que necesite más.
   */
  @Post('rooms')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  createRoom(@Req() req: Request) {
    const userId = requireUserId(req);
    // El nombre visible dentro de la sala es el id de sesión recortado y no el
    // email: el Prebuilt lo muestra a los demás participantes, y en una prueba
    // de videoconsulta no hace falta filtrar la identidad de nadie.
    return this.daily.createSpikeRoom(`Test ${userId.slice(0, 8)}`);
  }

  /** Métricas de las sesiones ya terminadas de una sala (criterio 3 del spike). */
  @Get('rooms/:name/sessions')
  getSessions(@Param('name', SpikeRoomNamePipe) name: string) {
    return this.daily.getMeetingSessions(name);
  }

  /** Borra la sala al terminar la prueba, para no dejarla consumiendo cuota. */
  @Delete('rooms/:name')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteRoom(@Param('name', SpikeRoomNamePipe) name: string) {
    return this.daily.deleteRoom(name);
  }
}
