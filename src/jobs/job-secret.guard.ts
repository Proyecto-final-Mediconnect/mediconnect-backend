import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Protege los endpoints que dispara el scheduler (`/internal/jobs/*`).
 *
 * El llamador es un workflow de GitHub Actions, no un usuario: no tiene JWT. La
 * barrera es un secreto compartido, `JOBS_SECRET`, que viaja como
 * `Authorization: Bearer <secreto>`.
 *
 * - Sin `JOBS_SECRET` configurado, 503: los jobs quedan apagados en vez de
 *   abiertos a cualquiera.
 * - La comparación es de tiempo constante sobre los hashes, así que no filtra
 *   por timing ni el contenido ni el largo del secreto.
 */
@Injectable()
export class JobSecretGuard implements CanActivate {
  private readonly logger = new Logger(JobSecretGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.get<string>('JOBS_SECRET');
    if (!secret) {
      this.logger.error('Jobs deshabilitados: falta JOBS_SECRET.');
      throw new ServiceUnavailableException('Jobs deshabilitados.');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!provided || !timingSafeEqual(digest(provided), digest(secret))) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
