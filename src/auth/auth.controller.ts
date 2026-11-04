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
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { RegisterProfessionalDto } from './dto/register-professional.dto';
import { legalAcceptanceContext } from '../legal/acceptance-context';
import { SkipLegal } from '../legal/skip-legal.decorator';
import { MfaCodeDto } from './dto/mfa.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { MfaService } from './mfa.service';

const ACCESS_TOKEN_COOKIE = 'sb-access-token';
const REFRESH_TOKEN_COOKIE = 'sb-refresh-token';
/**
 * El token del primer paso del ingreso cuando falta el código de la
 * verificación en dos pasos (ENG-88). Vive cinco minutos: lo justo para abrir
 * la app autenticadora y copiar el código.
 */
const MFA_PENDING_COOKIE = 'sb-mfa-pending';
const MFA_PENDING_MAX_AGE_MS = 5 * 60 * 1000;

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

// Pública: sin usuario no hay consentimiento que exigir (ENG-140).
@SkipLegal()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly mfa: MfaService,
  ) {}

  private setSessionCookies(
    res: Response,
    session: { accessToken: string; refreshToken: string },
  ) {
    AuthController.setSessionCookies(res, session);
  }

  private clearSessionCookies(res: Response) {
    const base = sessionCookieOptions();
    res.clearCookie(ACCESS_TOKEN_COOKIE, base);
    res.clearCookie(REFRESH_TOKEN_COOKIE, base);
  }

  /**
   * Static para que `MfaController` también la use: al activar la verificación
   * en dos pasos, la sesión pasa a `aal2` y las cookies se renuevan.
   */
  static setSessionCookies(
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

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  registerPatient(@Body() dto: RegisterPatientDto, @Req() req: Request) {
    return this.authService.registerPatient(dto, legalAcceptanceContext(req));
  }

  @Post('register/professional')
  @HttpCode(HttpStatus.CREATED)
  registerProfessional(
    @Body() dto: RegisterProfessionalDto,
    @Req() req: Request,
  ) {
    return this.authService.registerProfessional(
      dto,
      legalAcceptanceContext(req),
    );
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

    // ENG-88: con la verificación en dos pasos activa, la contraseña sola no
    // abre la sesión. El token del primer paso queda en una cookie aparte, de
    // cinco minutos, y la web pide el código.
    if (session.mfaRequired) {
      this.clearSessionCookies(res);
      res.cookie(MFA_PENDING_COOKIE, session.accessToken, {
        ...sessionCookieOptions(),
        maxAge: MFA_PENDING_MAX_AGE_MS,
      });
      return { user: session.user, mfaRequired: true };
    }

    // La sesión se guarda en cookies httpOnly (no accesibles por JS → mitiga
    // robo de token vía XSS). El cliente no recibe los tokens en el body.
    this.setSessionCookies(res, session);

    return { user: session.user };
  }

  /**
   * El segundo paso del ingreso (ENG-88): el código de la app autenticadora.
   * Cambia el token del primer paso por la sesión completa.
   *
   * Mismo rate limit que el login: un código de 6 dígitos se adivina por fuerza
   * bruta si se lo deja probar sin límite.
   */
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async verifyMfa(
    @Body() dto: MfaCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const pending = req.cookies?.[MFA_PENDING_COOKIE] as string | undefined;
    if (!pending) {
      throw new UnauthorizedException(
        'Pasaron más de cinco minutos. Ingresá tu email y contraseña de nuevo.',
      );
    }
    const session = await this.mfa.verifyLogin(pending, dto.code);
    res.clearCookie(MFA_PENDING_COOKIE, sessionCookieOptions());
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

  @Post('password/forgot')
  @HttpCode(HttpStatus.OK)
  // ENG-142: cada pedido manda un mail. 3 por IP por minuto alcanza para
  // reintentar y frena el uso del endpoint para spamear casillas ajenas.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  // Mismo límite que el login: el token del enlace no se puede adivinar, pero
  // no hay por qué dejar probar tokens sin freno.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
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
