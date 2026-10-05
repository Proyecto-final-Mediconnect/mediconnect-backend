import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { isIP } from 'node:net';

/**
 * Rate limit por IP real del cliente, no por IP del proxy (ENG-84).
 *
 * `ThrottlerGuard` identifica al cliente con `req.ip`. En producción eso no es
 * el cliente: delante de Render hay Cloudflare, y con `trust proxy = 1` Express
 * toma la última IP de `X-Forwarded-For`, que es la IP de salida de Cloudflare.
 * Medido contra el deploy el 23/09/2026: un solo cliente caía alternadamente
 * en **dos** contadores distintos, uno por cada IP de salida del edge de
 * Buenos Aires. El límite no era por usuario sino por IP de Cloudflare, así
 * que todos los usuarios de la región compartían dos cupos — y los de 5 por
 * minuto de `POST /auth/login` y `POST /auth/refresh` se agotaban con seis
 * personas iniciando sesión en el mismo minuto.
 *
 * `CF-Connecting-IP` lo escribe Cloudflare en cada request que atraviesa su
 * red y **reemplaza** cualquier valor que mande el cliente, así que no se puede
 * falsificar por ese camino. Es distinto de la primera posición de
 * `X-Forwarded-For`, que el cliente sí controla.
 *
 * Supuesto del que depende: que no haya forma de llegar al servicio sin pasar
 * por Cloudflare. Hoy es así, porque todo `*.onrender.com` resuelve a
 * Cloudflare. Si Render dejara de usarlo, el header deja de venir y el guard
 * vuelve a `req.ip`: se pierde precisión (otra vez por proxy), pero no se abre
 * una forma de esquivar el límite.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    const headers = req.headers as Record<string, unknown> | undefined;
    const cfIp = headers?.['cf-connecting-ip'];

    // Solo una IP bien formada. Un valor duplicado llega como "a, b" y no pasa
    // `isIP`: ante cualquier duda se usa `req.ip`, que es lo que hacía antes.
    if (typeof cfIp === 'string' && isIP(cfIp.trim()) !== 0) {
      return cfIp.trim();
    }

    return super.getTracker(req);
  }
}
