import 'dotenv/config';

/**
 * Los specs de integración crean roles, cambian GRANTs, prenden y apagan RLS y
 * borran filas: solo pueden correr contra una base descartable.
 *
 * Corridos con `npx jest` directo, sin `scripts/test-integration.sh`, toman la
 * `DATABASE_URL` del `.env`, que apunta a Supabase. Pasó (ENG-175): el
 * `afterAll` de un spec le sacó la RLS y las policies a `appointments` en
 * producción. Esta guarda corta antes de abrir una conexión.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const url = process.env.DATABASE_URL;
let host: string | null = null;
try {
  host = url ? new URL(url).hostname : null;
} catch {
  host = null;
}

if (!host || !LOCAL_HOSTS.has(host)) {
  throw new Error(
    `Los specs de integración solo corren contra una base local (DATABASE_URL apunta a "${host ?? 'nada'}"). ` +
      'Usá `bash scripts/test-integration.sh`.',
  );
}
