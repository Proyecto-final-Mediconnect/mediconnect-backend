/**
 * Caché corto de `profiles.mfa_enabled` por usuario (ENG-88), para que
 * `JwtAuthGuard` no haga una consulta a la base en cada request de quien no
 * tiene un token `aal2`.
 *
 * Es por proceso (en memoria). Se invalida al activar o desactivar la
 * verificación, así que el único desfase posible es con otra instancia del
 * backend, y dura como mucho `TTL_MS`.
 */
const TTL_MS = 30_000;
const MAX_ENTRIES = 10_000;

const cache = new Map<string, { enabled: boolean; expires: number }>();

export function getCachedMfa(userId: string): boolean | undefined {
  const hit = cache.get(userId);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(userId);
    return undefined;
  }
  return hit.enabled;
}

export function setCachedMfa(userId: string, enabled: boolean): void {
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(userId, { enabled, expires: Date.now() + TTL_MS });
}

export function invalidateMfaCache(userId: string): void {
  cache.delete(userId);
}

export function clearMfaCache(): void {
  cache.clear();
}
