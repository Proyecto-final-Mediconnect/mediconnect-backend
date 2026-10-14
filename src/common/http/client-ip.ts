import { isIP } from 'node:net';

/** Lo mínimo del request que hace falta para resolver la IP del cliente. */
interface RequestLike {
  headers?: unknown;
  ip?: unknown;
}

/**
 * `CF-Connecting-IP` si viene bien formado; si no, `undefined` (ENG-84).
 *
 * Cloudflare escribe el header en cada request que atraviesa su red y
 * **reemplaza** cualquier valor que mande el cliente, así que no se puede
 * falsificar por ese camino. Solo se acepta una IP válida: un valor duplicado
 * llega como "a, b" y no pasa `isIP`. El razonamiento completo está en
 * `ClientIpThrottlerGuard`.
 */
export function cloudflareClientIp(req: RequestLike): string | undefined {
  const headers = req.headers as Record<string, unknown> | undefined;
  const cfIp = headers?.['cf-connecting-ip'];
  if (typeof cfIp === 'string' && isIP(cfIp.trim()) !== 0) {
    return cfIp.trim();
  }
  return undefined;
}

/**
 * IP real del cliente: la de Cloudflare y, si no está, `req.ip` (que detrás del
 * proxy es la IP de salida de Cloudflare: menos precisa, pero no falsificable).
 * `null` si ninguna de las dos es una IP válida, así se puede guardar en una
 * columna `inet` sin que un valor raro rompa el insert.
 */
export function clientIp(req: RequestLike): string | null {
  const cf = cloudflareClientIp(req);
  if (cf) return cf;
  return typeof req.ip === 'string' && isIP(req.ip) !== 0 ? req.ip : null;
}
