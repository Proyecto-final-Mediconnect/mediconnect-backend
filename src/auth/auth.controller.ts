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

/**
 * Opciones de cookie compartidas por login/refresh/logout (deben coincidir
 * para que `res.clearCookie` efectivamente las borre del browser).
 *
 * `sameSite` NO puede ser fijo. En producción la web y la API viven en hosts
 * distintos —`mediconnect-web-*.onrender.com` y `mediconnect-backend-*.onrender.com`—
 * y `onrender.com` está en la Public Suffix List, así que para el navegador no
 * son dos subdominios de un mismo sitio: son **sitios distintos**. Con `Lax`, el
 * navegador descarta la cookie que llega en una respuesta cross-site, y el login
 * queda roto de una forma engañosa: `POST /auth/login` devuelve 200 con su
 * `Set-Cookie`, pero la sesión no se guarda y el `GET /me` siguiente responde 401.
 *
 * En desarrollo se mantiene `Lax`: `localhost:5173` y `localhost:3000` son el
 * mismo sitio, así que `None` no aportaría nada y además exige `Secure`, que
 * sobre http no se puede usar. Por eso este bug es invisible en local — el mismo
 * patrón de ENG-96, ENG-122 y ENG-124.
 *
 * `SameSite=None` requiere `Secure`, que ya viene de `isProd`. Los dos tienen que
 * seguir atados a la misma condición: `None` sin `Secure` lo rechaza el browser.
 */
function sessionCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ('none' as const) : ('lax' as const),
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
  // ENG-44: 5 intentos por IP por minuto. Frena el fuerza bruta de contraseñas
  // sin depender solo del rate limit de Supabase (que es por proyecto, no por IP).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
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
