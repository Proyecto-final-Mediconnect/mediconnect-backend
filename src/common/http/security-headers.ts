import helmet from 'helmet';

/**
 * Headers de seguridad de la API (Sprint 0 §5.5.4 y §4.8.3, ENG-166).
 *
 * Es una API JSON: no sirve HTML ni scripts, así que la CSP es la más cerrada
 * posible (`default-src 'none'`) y nadie la puede embeber en un iframe
 * (`frame-ancestors 'none'` y `X-Frame-Options: DENY`). Con eso, una respuesta
 * que por error se abra en el navegador no puede ejecutar nada ni usarse para
 * clickjacking.
 *
 * `crossOriginResourcePolicy` queda en `cross-origin`: la web vive en otro
 * dominio y lee las respuestas con CORS (ver `enableCors` en `main.ts`); con el
 * default de helmet (`same-origin`) el navegador las bloquearía.
 *
 * HSTS va con un año y subdominios: en producción todo es HTTPS detrás de
 * Render y Cloudflare.
 */
export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
  });
}
