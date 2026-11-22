import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { user_role } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ROLES_KEY } from '../decorators/roles.decorator';

/** El mismo mensaje para cualquier rol que no corresponda: no dice cuál hace falta. */
export const ROLE_FORBIDDEN_MESSAGE = 'No tenés permiso para entrar acá.';

/**
 * Deja pasar solo a los roles de `@Roles(...)` (ENG-240).
 *
 * El rol se lee de `profiles` y **no** del JWT: el `role` del token es el rol de
 * Postgres que pone Supabase ("authenticated"), y el `user_metadata` lo
 * controla el cliente (ENG-37). Un perfil borrado (ARCO) tampoco pasa.
 *
 * **Falla cerrado:** si se usa sin `@Roles(...)` no deja pasar a nadie. Un
 * endpoint de administración que se olvidó el decorador no puede quedar
 * abierto para cualquier usuario logueado.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = this.reflector.getAllAndOverride<user_role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!allowed || allowed.length === 0) {
      this.logger.error(
        `RolesGuard sin @Roles en ${context.getClass().name}.${context.getHandler().name}: se niega el acceso.`,
      );
      throw new ForbiddenException(ROLE_FORBIDDEN_MESSAGE);
    }

    const userId = context.switchToHttp().getRequest<Request>().user?.id;
    if (!userId) {
      // Sin `JwtAuthGuard` antes no hay sesión verificada.
      throw new UnauthorizedException('No se encontró un token de sesión.');
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { role: true, deleted_at: true },
    });
    if (!profile || profile.deleted_at || !allowed.includes(profile.role)) {
      throw new ForbiddenException(ROLE_FORBIDDEN_MESSAGE);
    }
    return true;
  }
}
