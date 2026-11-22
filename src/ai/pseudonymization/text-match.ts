/**
 * Búsqueda de un valor conocido dentro de una transcripción, tolerante a cómo la
 * escribe el transcriptor: con o sin tildes ("Lucía" / "Lucia"), con espacios de
 * más y, para los números, con o sin puntos y guiones ("30.123.456" / "30123456").
 */

const ACCENT_VARIANTS: Readonly<Record<string, string>> = {
  a: 'aáàäâ',
  e: 'eéèëê',
  i: 'iíìïî',
  o: 'oóòöô',
  u: 'uúùüû',
  n: 'nñ',
  c: 'cç',
};

/** Sin tildes, en minúsculas y con los espacios juntos: la forma de comparar. */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compila un patrón armado acá a partir de valores conocidos. Todo valor entra
 * escapado (`escapeRegExp`, `loosePattern`, `digitsPattern`), así que no hay
 * forma de inyectar un patrón; y ninguno anida cuantificadores (lo mide
 * `pseudonymizer.spec.ts` con textos armados para forzar backtracking).
 */
export function compilePattern(source: string, flags: string): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- ver arriba: la fuente se arma solo con valores escapados
  return new RegExp(source, flags);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ni pegado a una letra o un número, ni adentro de un marcador (`[PERSONA_1]`). */
export const BEFORE = '(?<![\\p{L}\\p{N}\\[_])';
export const AFTER = '(?![\\p{L}\\p{N}\\]_])';

/**
 * El patrón (sin flags) de un texto conocido, sin importar tildes. Con
 * `capitalized`, la primera letra tiene que ir en mayúscula: así el apellido
 * "Paz" se tapa y la palabra "paz" no.
 */
export function loosePattern(
  value: string,
  { capitalized }: { capitalized: boolean },
): string {
  const base = foldText(value);
  let pattern = '';
  for (let i = 0; i < base.length; i++) {
    const char = base[i];
    if (char === ' ') {
      pattern += '\\s+';
      continue;
    }
    const variants = ACCENT_VARIANTS[char] ?? char;
    const upper = variants.toUpperCase();
    if (variants === upper) {
      // No es una letra: va literal.
      pattern += escapeRegExp(char);
    } else if (i === 0 && capitalized) {
      pattern += `[${upper}]`;
    } else {
      pattern += `[${variants}${upper}]`;
    }
  }
  return pattern;
}

/**
 * El patrón de un número conocido (DNI, teléfono) con cualquier separador entre
 * dígitos: "30.123.456", "30 123 456" y "30123456" dan lo mismo.
 */
export function digitsPattern(digits: string): string {
  return digits.split('').join('[\\s.\\-]?');
}

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}
