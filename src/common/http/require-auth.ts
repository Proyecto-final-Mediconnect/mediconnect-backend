import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/** Sesión ya verificada por `JwtAuthGuard`. */
export interface AuthContext {
  /** `payload.sub` del JWT — coincide con `profiles.id` y con `auth.uid()`. */
  userId: string;
  /** Token crudo, para construir un cliente Supabase scopeado al usuario (RLS). */
  accessToken: string;
}

/**
 * `JwtAuthGuard` garantiza `user` y `accessToken` en el request; este helper lo
 * hace explícito para TypeScript sin repartir `!` por los handlers.
 */
export function requireAuth(req: Request): AuthContext {
  if (!req.user?.id || !req.accessToken) {
    throw new UnauthorizedException('No se encontró un token de sesión.');
  }
  return { userId: req.user.id, accessToken: req.accessToken };
}
