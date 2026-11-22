// ENG-216 — Genera una clave maestra nueva para DATA_ENCRYPTION_KEYS.
//
//   pnpm run keys:generate        → k1:<clave>
//   pnpm run keys:generate k2     → k2:<clave> (para rotar)
//
// No toca la base ni lee ningún .env: solo imprime una línea al azar. Esa línea
// es un SECRETO: se pega directo en Render (y en el secret de GitHub del job de
// integridad), se guarda un respaldo fuera de Render y no se manda por chat, mail
// ni commit. Ver "Cifrado del contenido clínico" en el README.

import { generateKeyEntry } from '../src/common/crypto/data-encryption';

const kid = process.argv[2] ?? 'k1';

try {
  console.log(generateKeyEntry(kid));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
