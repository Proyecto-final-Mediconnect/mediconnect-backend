import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Loguea método, path, status y usuario (si el request pasó por
 * `JwtAuthGuard`) de cada request. Deliberadamente NO loguea body, headers,
 * cookies ni el token — para no volcar passwords o JWTs a los logs. El
 * identificador de usuario es el `sub` del JWT (uuid), nunca el email.
 */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - start;
      const userId = req.user?.id ?? 'anon';
      this.logger.log(
        `${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms user=${userId}`,
      );
    });

    next();
  }
}
