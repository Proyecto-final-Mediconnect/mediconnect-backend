import type { Request } from 'express';

/**
 * El origen público del backend, tal como lo llamó el cliente
 * (`https://...`). Con `trust proxy` (ver `app.setup.ts`), `req.protocol` es el
 * que vio Render y no el `http` interno. Sirve para armar links propios que el
 * cliente abre directo, como los de `GET /files`.
 */
export function publicBaseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}
