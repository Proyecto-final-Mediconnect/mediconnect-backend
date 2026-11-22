import { SetMetadata } from '@nestjs/common';
import type { user_role } from '../../../generated/prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Los roles de dominio que pueden entrar a un handler o a un controller entero
 * (ENG-240). Lo hace cumplir `RolesGuard`, que va **después** de `JwtAuthGuard`:
 *
 * ```ts
 * @UseGuards(JwtAuthGuard, RolesGuard)
 * @Roles('ADMINISTRADOR')
 * ```
 */
export const Roles = (...roles: user_role[]) => SetMetadata(ROLES_KEY, roles);
