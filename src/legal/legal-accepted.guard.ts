import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { LEGAL_NOT_ACCEPTED_MESSAGE, LEGAL_VERSION } from './legal';
import { SKIP_LEGAL_KEY } from './skip-legal.decorator';

/** `code` del 403: la web lo usa para mandar al usuario a aceptar los textos. */
export const LEGAL_NOT_ACCEPTED_CODE = 'LEGAL_NOT_ACCEPTED';

/**
 * Exige que el usuario autenticado haya aceptado la versión vigente de los
 * textos legales (ENG-140). Sin eso, 403 con `code: 'LEGAL_NOT_ACCEPTED'`.
 *
 * Es la única barrera real: el backend bypassea RLS, y el checkbox de la web y
 * el `@Equals` del registro se esquivan con la app mobile, con un cliente HTTP
 * cualquiera o con un `signUp` directo contra Supabase Auth (el trigger
 * `on_auth_user_created` crea el perfil sin pasar por nuestro DTO).
 *
 * **No se registra suelto ni como `APP_GUARD`.** Los guards globales corren
 * antes que los de controller, así que todavía no habría `request.user`. Lo
 * invoca `JwtAuthGuard` al final, después de verificar el token: toda ruta
 * autenticada lo exige por default, y una ruta nueva no puede olvidárselo. Las
 * excepciones se marcan con `@SkipLegal()`.
 *
 * Es una consulta por request, por la unique `(profile_id, version)`. Se
 * prefirió eso a una caché: al aceptar o al cambiar `LEGAL_VERSION` el efecto
 * es inmediato, sin invalidaciones.
 */
@Injectable()
export class LegalAcceptedGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(
      SKIP_LEGAL_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skip) return true;

    const user = context.switchToHttp().getRequest<Request>().user;
    // Fail-closed: si alguien lo usara sin `JwtAuthGuard` delante, no deja
    // pasar a nadie en vez de dejar pasar a todos.
    if (!user?.id) {
      throw new UnauthorizedException('No se encontró un token de sesión.');
    }

    const accepted = await this.prisma.legalAcceptance.findUnique({
      where: {
        profile_id_version: { profile_id: user.id, version: LEGAL_VERSION },
      },
      select: { id: true },
    });
    if (!accepted) {
      throw new ForbiddenException({
        statusCode: 403,
        code: LEGAL_NOT_ACCEPTED_CODE,
        message: LEGAL_NOT_ACCEPTED_MESSAGE,
        legalVersion: LEGAL_VERSION,
      });
    }
    return true;
  }
}
