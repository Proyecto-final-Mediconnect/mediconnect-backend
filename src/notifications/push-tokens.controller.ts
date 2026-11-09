import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';
import { EXPO_PUSH_TOKEN_PATTERN, PushService } from './push.service';

/**
 * Los tokens de push de la app mobile (ENG-71). La app registra el del
 * dispositivo al iniciar sesión (si el usuario dio permiso) y lo borra al
 * cerrarla, antes de soltar la sesión.
 */
@Controller('push-tokens')
@UseGuards(JwtAuthGuard)
export class PushTokensController {
  constructor(private readonly push: PushService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async register(
    @Req() req: Request,
    @Body() dto: RegisterPushTokenDto,
  ): Promise<void> {
    const { userId } = requireAuth(req);
    await this.push.register(userId, dto.token, dto.platform);
  }

  /** Idempotente: borrar un token que no está (o que es de otro) da 204 igual. */
  @Delete(':token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregister(
    @Req() req: Request,
    @Param('token') token: string,
  ): Promise<void> {
    const { userId } = requireAuth(req);
    if (!EXPO_PUSH_TOKEN_PATTERN.test(token)) {
      throw new BadRequestException('El token de notificaciones no es válido.');
    }
    await this.push.unregister(userId, token);
  }
}
