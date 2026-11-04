import { Injectable, SetMetadata } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { clientIp } from '../http/client-ip';

export const USER_THROTTLE_KEY = 'throttler:user-keyed';

/**
 * Marca un handler para que su límite se cuente por usuario autenticado y no
 * por IP. Requiere `UserThrottlerGuard` en el handler, después de
 * `JwtAuthGuard`, y hace que el `ClientIpThrottlerGuard` global no lo cuente.
 */
export const UserThrottled = () => SetMetadata(USER_THROTTLE_KEY, true);

/**
 * Rate limit por usuario. Va como guard de la ruta, no global: los globales
 * corren antes que `JwtAuthGuard`, así que `req.user` todavía no existe.
 *
 * Sin usuario (ruta sin auth) cae a la IP real del cliente.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { id?: unknown } | undefined;
    if (typeof user?.id === 'string' && user.id) {
      return Promise.resolve(`user:${user.id}`);
    }

    return Promise.resolve(`ip:${clientIp(req) ?? 'desconocida'}`);
  }
}
