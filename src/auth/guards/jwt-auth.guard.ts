import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { jwtVerify, type JWTPayload } from 'jose';
import { JOSEError, JWKSTimeout } from 'jose/errors';
import { SupabaseService } from '../../supabase/supabase.service';

/** Nombre de la cookie httpOnly seteada en `AuthController.login`. */
const ACCESS_TOKEN_COOKIE = 'sb-access-token';

/** `aud` que Supabase Auth asigna a los tokens de sesión de usuario. */
const EXPECTED_AUDIENCE = 'authenticated';

function extractToken(request: Request): string | undefined {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }
  return request.cookies?.[ACCESS_TOKEN_COOKIE] as string | undefined;
}

/**
 * Verifica JWTs de Supabase Auth localmente contra el JWKS del proyecto
 * (firma ES256 + issuer + audiencia + expiración), sin llamar a Supabase por
 * request (ver ENG-40). Adjunta el usuario autenticado a `request.user`.
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

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.supabase.getJWKS(), {
        issuer: this.supabase.getIssuer(),
        audience: EXPECTED_AUDIENCE,
        algorithms: ['ES256'],
      }));
    } catch (err) {
      // Un timeout/fetch fallido contra el JWKS es un problema de infra, no
      // un token inválido: no lo disfracemos de 401 (confunde "no estás
      // autenticado" con "Supabase no responde").
      if (err instanceof JWKSTimeout || !(err instanceof JOSEError)) {
        throw new ServiceUnavailableException(
          'No pudimos verificar tu sesión. Probá de nuevo en unos minutos.',
        );
      }
      throw new UnauthorizedException('Token inválido o expirado.');
    }

    if (!payload.sub) {
      throw new UnauthorizedException('El token no tiene un sujeto válido.');
    }

    request.user = {
      id: payload.sub,
      email: payload.email as string | undefined,
      // `role` es el rol de Postgres que asigna Supabase Auth (siempre
      // "authenticated" para un usuario logueado) — NO el rol de dominio
      // (PACIENTE/PROFESIONAL/MODERADOR, que vive en `profiles`). No usar
      // este campo para autorización basada en roles (ver ENG-37).
      role: payload.role as string | undefined,
    };

    return true;
  }
}
