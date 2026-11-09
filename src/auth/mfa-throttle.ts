import { createHash } from 'node:crypto';
import { cloudflareClientIp } from '../common/http/client-ip';

/**
 * Hash del token del primer paso (ENG-88), para no guardar el token en claro.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Tracker del rate limit del segundo paso: por token pendiente y no por IP.
 * Por IP, quien prueba códigos desde varias IPs (o detrás de un NAT compartido)
 * esquiva el límite o perjudica a otros. Sin token, cae a la IP real del
 * cliente con la misma regla que `ClientIpThrottlerGuard` (ENG-84):
 * `CF-Connecting-IP` y, si no viene, `req.ip`.
 */
export function mfaPendingTracker(req: Record<string, unknown>): string {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const body = req.body as { mfaToken?: unknown } | undefined;
  const token = cookies?.['sb-mfa-pending'] ?? body?.mfaToken;
  if (typeof token === 'string' && token) return `mfa:${hashToken(token)}`;
  const cfIp = cloudflareClientIp(req);
  if (cfIp) return cfIp;
  return typeof req.ip === 'string' ? req.ip : 'unknown';
}
