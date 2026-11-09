import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { requireAuth } from '../common/http/require-auth';
import { AuthController } from './auth.controller';
import { MfaCodeDto, MfaEnrollVerifyDto } from './dto/mfa.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MfaService, mfaAuditContext } from './mfa.service';

/**
 * Activar y desactivar la verificación en dos pasos (ENG-88). Es opcional y
 * para los tres roles.
 *
 * Todo con `no-store`: el alta devuelve la clave secreta del factor.
 */
@Controller('me/mfa')
@UseGuards(JwtAuthGuard)
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async status(@Req() req: Request): Promise<{ activa: boolean }> {
    const { accessToken } = requireAuth(req);
    return { activa: await this.mfa.isEnabled(accessToken) };
  }

  /** Empieza el alta: devuelve el QR para escanear con la app autenticadora. */
  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  enroll(@Req() req: Request) {
    const { userId, accessToken } = requireAuth(req);
    return this.mfa.startEnrollment(userId, accessToken, mfaAuditContext(req));
  }

  /**
   * Termina el alta con el primer código. La sesión de quien la activa pasa a
   * tener el segundo paso hecho: en la web se renuevan las cookies, y a un
   * cliente con `Authorization: Bearer` se le devuelven los tokens nuevos.
   */
  @Post('enroll/verify')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async verifyEnrollment(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: MfaEnrollVerifyDto,
  ) {
    const { userId, accessToken } = requireAuth(req);
    const session = await this.mfa.confirmEnrollment(
      userId,
      accessToken,
      dto.factorId,
      dto.code,
      mfaAuditContext(req),
    );
    if (req.headers.authorization?.startsWith('Bearer ')) {
      return {
        activa: true,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      };
    }
    AuthController.setSessionCookies(res, session);
    return { activa: true };
  }

  /** La desactiva. Pide un código de la app igual, aunque haya sesión. */
  @Post('disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async disable(@Req() req: Request, @Body() dto: MfaCodeDto): Promise<void> {
    const { userId, accessToken } = requireAuth(req);
    await this.mfa.disable(userId, accessToken, dto.code, mfaAuditContext(req));
  }
}
