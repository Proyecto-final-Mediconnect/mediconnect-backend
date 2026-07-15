import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { jwtVerify } from 'jose';
import { SupabaseService } from '../../supabase/supabase.service';

/** Nombre de la cookie httpOnly seteada en `AuthController.login`. */
const ACCESS_TOKEN_COOKIE = 'sb-access-token';

function extractToken(request: Request): string | undefined {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }
  return request.cookies?.[ACCESS_TOKEN_COOKIE] as string | undefined;
}

/**
 * Verifica JWTs de Supabase Auth localmente contra el JWKS del proyecto
 * (firma ES256 + issuer + expiración), sin llamar a Supabase por request
 * (ver ENG-40). Adjunta el usuario autenticado a `request.user`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No se encontró un token de sesión.');
    }

    try {
      const { payload } = await jwtVerify(token, this.supabase.getJWKS(), {
        issuer: this.supabase.getIssuer(),
      });

      request.user = {
        id: payload.sub as string,
        email: payload.email as string | undefined,
        role: payload.role as string | undefined,
      };
    } catch {
      throw new UnauthorizedException('Token inválido o expirado.');
    }

    return true;
  }
}
