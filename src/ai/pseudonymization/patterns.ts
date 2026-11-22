import type { MarkerKind } from './markers';

/**
 * Capa 2 — Identificadores con forma reconocible que el sistema no conoce de
 * antemano: el DNI de un familiar, un teléfono, una fecha de nacimiento.
 *
 * El orden importa: va de lo más específico a lo más general, y lo que ya es un
 * marcador no se vuelve a tocar.
 *
 * `security/detect-unsafe-regex` marca varios por heurística (un cuantificador
 * dentro de otro), pero ninguno es ambiguo: lo que repite el grupo de afuera
 * está separado por un carácter que el de adentro no acepta. Están medidos:
 * `pseudonymizer.spec.ts` los corre contra textos de 100.000 caracteres armados
 * para forzar backtracking y falla si alguno tarda.
 */
/* eslint-disable security/detect-unsafe-regex -- medidos, ver arriba */
export const IDENTIFIER_PATTERNS: readonly (readonly [MarkerKind, RegExp])[] = [
  // El lookbehind hace que solo se intente desde el principio de la palabra: sin
  // él, una palabra larga sin `@` se recorre una vez por cada letra (cuadrático).
  ['MAIL', /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu],
  ['URL', /\b(?:https?:\/\/|www\.)[^\s,;)]+/giu],
  // CUIT/CUIL: 20-30123456-7, con o sin guiones.
  ['CUIL', /\b(?:20|23|24|27|30|33|34)-?\d{8}-?\d\b/gu],
  // El número que sigue a "afiliado", "credencial" o "carnet".
  [
    'AFILIADO',
    /(?<=\b(?:afiliad[oa]|credencial|carnet)(?:\s+(?:n(?:ú|u)mero|nro\.?|n°|es|de))*\s*:?\s*)\d[\d\s/-]{4,}\d/giu,
  ],
  // 14/02/1983, 14-2-83, 14.02.1983.
  ['FECHA', /\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})\b/gu],
  // "14 de febrero de 1983": con año, porque sin año suele ser una fecha de la
  // consulta ("vuelva el 3 de marzo"), que el resumen necesita.
  [
    'FECHA',
    /\b\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|se(?:p)?tiembre|octubre|noviembre|diciembre)\s+(?:de|del)\s+\d{4}\b/giu,
  ],
  // DNI con puntos: 30.123.456 o 5.123.456.
  ['DNI', /\b\d{1,2}\.\d{3}\.\d{3}\b/gu],
  // DNI sin puntos, solo si se dice que es un DNI.
  [
    'DNI',
    /(?<=\b(?:dni|documento)(?:\s+(?:es|n(?:ú|u)mero|nro\.?|n°|de))*\s*:?\s*)\d{7,8}\b/giu,
  ],
  // "Avenida Colón 1234", "calle San Martín 450".
  [
    'DIRECCION',
    /\b(?:calle|avenida|av\.|avda\.|pasaje|boulevard|bulevar|bv\.|diagonal)\s+(?:[\p{L}\d.]+\s+){1,4}?\d{1,5}\b/giu,
  ],
  // Teléfonos argentinos: 351 555-0199, +54 9 11 4567-8901, 1145678901.
  [
    'TELEFONO',
    /(?:\+?54[\s-]?)?(?:9[\s-]?)?\b\d{2,4}[\s-]?\d{3,4}[\s-]?\d{4}\b/gu,
  ],
  // Un número local sin característica, con separador: 555-0199, 422 3344.
  ['TELEFONO', /\b\d{3,4}[\s-]\d{4}\b/gu],
  // Cualquier otro número largo (8 dígitos o más, juntos o con puntos o
  // guiones): casi nunca es un dato clínico y muchas veces es un documento o
  // una cuenta. Sin espacios, para no juntar valores dictados seguidos
  // ("120 80 70 80").
  ['NUMERO', /\b\d(?:[.-]?\d){7,}\b/gu],
];
/* eslint-enable security/detect-unsafe-regex */
