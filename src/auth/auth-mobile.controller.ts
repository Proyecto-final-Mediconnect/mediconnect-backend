import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

/** Sesión que recibe la app mobile: los mismos tokens que la web recibe en cookies. */
export interface MobileSessionResponse {
  user: { id: string; email?: string };
  accessToken: string;
  refreshToken: string;
}

/**
 * Login y refresh para la app mobile (ENG-114).
 *
 * La web guarda la sesión en cookies httpOnly (`AuthController`), pero React
 * Native no tiene un almacén de cookies que la app controle: la app necesita
 * los tokens en el body para guardarlos en `expo-secure-store` (Keychain /
 * Keystore) y mandarlos como `Authorization: Bearer`, que `JwtAuthGuard` ya
 * acepta.
 *
 * Son rutas aparte, y no un flag en `/auth/login`, a propósito:
 * - El contrato de la web ("los tokens nunca llegan al JS del browser") queda
 *   intacto y sin una rama que alguien pueda activar mandando un header.
 * - No setean cookies: un token en el body y otro en una cookie serían dos
 *   copias de la misma sesión con ciclos de vida distintos.
 *
 * Reusan `AuthService` tal cual, así que los errores son los mismos que en la
 * web: credenciales inválidas y email sin confirmar dan el mismo 401 genérico
 * (anti-enumeración), y una caída de Supabase da 503 y no 401 —el cliente no
 * debe borrar la sesión por eso—.
 *
 * Mismo rate limit que las rutas de la web (5/min por cliente), por las mismas
 * razones: fuerza bruta en el login y el reuso de refresh tokens que Supabase
 * no detecta (docs/security/refresh-token-reuse-risk-plan.md).
 *
 * `Cache-Control: no-store` porque la respuesta lleva credenciales (RFC 6749
 * §5.1): ningún proxy ni caché del cliente debe guardarla.
 */
@Controller('auth/mobile')
export class AuthMobileController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(@Body() dto: LoginDto): Promise<MobileSessionResponse> {
    const { user, accessToken, refreshToken } =
      await this.authService.login(dto);
    return { user, accessToken, refreshToken };
  }

  /**
   * Supabase rota el refresh token en cada uso: el cliente tiene que
   * reemplazar los dos tokens guardados por los que devuelve esta ruta.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async refresh(@Body() dto: RefreshTokenDto): Promise<MobileSessionResponse> {
    const { user, accessToken, refreshToken } = await this.authService.refresh(
      dto.refreshToken,
    );
    return { user, accessToken, refreshToken };
  }
}
