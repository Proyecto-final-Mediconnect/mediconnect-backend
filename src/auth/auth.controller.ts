import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { RegisterProfessionalDto } from './dto/register-professional.dto';

const ACCESS_TOKEN_COOKIE = 'sb-access-token';
const REFRESH_TOKEN_COOKIE = 'sb-refresh-token';

/** Opciones de cookie compartidas por login/refresh/logout (deben coincidir
 *  para que `res.clearCookie` efectivamente las borre del browser). */
function sessionCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private setSessionCookies(
    res: Response,
    session: { accessToken: string; refreshToken: string },
  ) {
    const base = sessionCookieOptions();
    res.cookie(ACCESS_TOKEN_COOKIE, session.accessToken, {
      ...base,
      maxAge: 60 * 60 * 1000, // 1 h
    });
    res.cookie(REFRESH_TOKEN_COOKIE, session.refreshToken, {
      ...base,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
    });
  }

  private clearSessionCookies(res: Response) {
    const base = sessionCookieOptions();
    res.clearCookie(ACCESS_TOKEN_COOKIE, base);
    res.clearCookie(REFRESH_TOKEN_COOKIE, base);
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  registerPatient(@Body() dto: RegisterPatientDto) {
    return this.authService.registerPatient(dto);
  }

  @Post('register/professional')
  @HttpCode(HttpStatus.CREATED)
  registerProfessional(@Body() dto: RegisterProfessionalDto) {
    return this.authService.registerProfessional(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.authService.login(dto);

    // La sesión se guarda en cookies httpOnly (no accesibles por JS → mitiga
    // robo de token vía XSS). El cliente no recibe los tokens en el body.
    this.setSessionCookies(res, session);

    return { user: session.user };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  // Supabase no está rechazando el reuso de refresh tokens (ver
  // docs/security/refresh-token-reuse-risk-plan.md) — limitamos fuerte por
  // IP como mitigación de defensa en profundidad mientras se resuelve.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE] as
      | string
      | undefined;

    if (!refreshToken) {
      throw new UnauthorizedException(
        'No se encontró una sesión para renovar.',
      );
    }

    let session: Awaited<ReturnType<AuthService['refresh']>>;
    try {
      session = await this.authService.refresh(refreshToken);
    } catch (err) {
      // Un refresh token inválido/vencido/ya usado no se puede reintentar:
      // limpiamos las cookies para que el frontend sepa que hay que
      // loguearse de nuevo (un 503 por rate limit no borra la sesión).
      if (err instanceof UnauthorizedException) {
        this.clearSessionCookies(res);
      }
      throw err;
    }

    // Supabase rota el refresh token en cada uso: el par devuelto acá
    // reemplaza a ambas cookies, no solo al access token.
    this.setSessionCookies(res, session);

    return { user: session.user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response) {
    // Idempotente y sin Guard: borrar las cookies no requiere que el token
    // siga siendo válido (puede haber expirado y el cliente igual quiere
    // limpiar su estado de sesión).
    this.clearSessionCookies(res);

    return { message: 'Sesión cerrada.' };
  }
}
