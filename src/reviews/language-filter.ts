/**
 * Filtro automático de lenguaje inapropiado (ENG-107).
 *
 * Corre **antes** de la moderación humana (ENG-81), no en su lugar: lo que pasa
 * el filtro igual lo lee un moderador antes de publicarse. Su trabajo es que el
 * moderador no tenga que leer insultos y que el texto ofensivo no llegue ni a la
 * cola. Se aplica a las reseñas de los pacientes y a las respuestas de los
 * profesionales (ENG-106).
 *
 * ## Qué detecta
 *
 * Insultos y groserías en castellano rioplatense, comparando **palabras
 * enteras** después de normalizar el texto:
 *
 * - minúsculas y sin acentos ("PELOTUDÓ" → "pelotudo");
 * - los reemplazos típicos para esquivar filtros ("b0lud0", "p3l0tud0",
 *   "f0rr@", "$orete");
 * - las letras estiradas ("boluuudooo");
 * - los separadores dentro de la palabra ("p.e.l.o.t.u.d.o", "h-d-p").
 *
 * Palabras enteras y no subcadenas, porque si no "computadora" tendría "puta"
 * y "disputa" también: un filtro que rechaza reseñas normales es peor que no
 * tenerlo.
 *
 * ## Qué no detecta
 *
 * Una crítica dura sin insultos ("me atendió tarde y fue maleducado") no es
 * lenguaje inapropiado: es justamente lo que una reseña tiene que poder decir,
 * y queda para el moderador. Tampoco intenta entender ironía ni contexto.
 */

/**
 * Palabras que no se publican, ya normalizadas. Incluye sus formas en plural y
 * femenino cuando se usan: la lista es corta y explícita a propósito, para que
 * se pueda revisar de un vistazo qué se bloquea.
 *
 * Quedan afuera a propósito las que también son palabras comunes en una
 * reseña, como "retrasado" ("el turno se había retrasado"), o que son nombres
 * o apellidos ("concha", "orto"), o ambiguas ("trola", "chanta"). Las que son
 * ofensivas solo en una frase ("la concha de tu madre") van en FRASES.
 */
const PALABRAS = new Set([
  'boludo',
  'boluda',
  'boludos',
  'boludas',
  'pelotudo',
  'pelotuda',
  'pelotudos',
  'pelotudas',
  'forro',
  'forra',
  'forros',
  'forras',
  'pajero',
  'pajera',
  'pajeros',
  'puto',
  'puta',
  'putos',
  'putas',
  'putazo',
  'trolo',
  'mierda',
  'mierdas',
  'mierdoso',
  'garca',
  'garcas',
  'sorete',
  'soretes',
  'conchudo',
  'conchuda',
  'culiado',
  'culiao',
  'culiada',
  'pija',
  'poronga',
  'carajo',
  'idiota',
  'idiotas',
  'imbecil',
  'imbeciles',
  'estupido',
  'estupida',
  'estupidos',
  'tarado',
  'tarada',
  'mogolico',
  'mogolica',
  'hdp',
  'hdmp',
  'lpm',
  'lpqtp',
  'ctm',
  'cagon',
  'cagona',
  'pendejo',
  'pendeja',
  'cabron',
  'cabrona',
  'gilipollas',
  'malparido',
  'malparida',
]);

/** Frases de varias palabras, normalizadas, que se buscan como tales. */
const FRASES = [
  'hijo de puta',
  'hija de puta',
  'hijos de puta',
  'la puta madre',
  'la concha de tu madre',
  'la concha de la lora',
  'andate a la mierda',
  'chupame la pija',
  'me cago en',
  'negro de mierda',
  'la concha de tu hermana',
  'concha de tu madre',
  'en el orto',
];

/** Los reemplazos de letras más comunes para esquivar un filtro. */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

/** Letras de otros alfabetos que se ven como una latina ("pelоtudo" con o cirílica). */
const HOMOGLIFOS: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  н: 'h',
  т: 't',
  в: 'b',
  ѕ: 's',
  α: 'a',
  ε: 'e',
  ο: 'o',
  ρ: 'p',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  τ: 't',
  υ: 'u',
  χ: 'x',
};

/**
 * Lleva el texto a una forma comparable: minúsculas, sin acentos, sin
 * reemplazos de letras y sin letras estiradas. Las palabras quedan separadas
 * por un espacio.
 */
export function normalize(text: string): string {
  return (
    text
      // Ancho completo y formas compatibles ("ｆｏｒｒｏ" → "forro").
      .normalize('NFKC')
      // Caracteres invisibles (ancho cero, soft hyphen, marcas bidi): \p{Cf}.
      .replace(/\p{Cf}/gu, '')
      .toLowerCase()
      .replace(/[а-яѐ-џα-ω]/g, (c) => HOMOGLIFOS[c] ?? c)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[013457@$]/g, (c) => LEET[c] ?? c)
      // "p.e.l.o.t.u.d.o" o "h-d-p": letras sueltas separadas por puntos,
      // guiones, guiones bajos o asteriscos se juntan en una palabra.
      .replace(/(?<![a-zñ])(?:[a-zñ][.\-_*]){2,}[a-zñ](?![a-zñ])/g, (m) =>
        m.replace(/[.\-_*]/g, ''),
      )
      // Todo lo que no es letra separa palabras.
      .replace(/[^a-zñ]+/g, ' ')
      // "boluuudooo" → "boluudoo" (y "forrro" → "forro"): tres o más iguales
      // bajan a dos; findInappropriate prueba también sin dobles.
      .replace(/([a-zñ])\1{2,}/g, '$1$1')
      // "p e l o t u d o": cuatro o más letras sueltas seguidas se juntan.
      .replace(/(?<![a-zñ])[a-zñ](?: [a-zñ]){3,}(?![a-zñ])/g, (m) =>
        m.replace(/ /g, ''),
      )
      .trim()
  );
}

/**
 * Las palabras o frases inapropiadas que tiene el texto, normalizadas y sin
 * repetir. Vacío si no tiene ninguna.
 */
export function findInappropriate(text: string): string[] {
  const normal = normalize(text);
  if (!normal) return [];
  const encontradas = new Set<string>();

  for (const palabra of normal.split(' ')) {
    if (PALABRAS.has(palabra)) encontradas.add(palabra);
    // "boluudo" queda "boludo" recién al bajar las dobles: se prueba también.
    const sinDobles = palabra.replace(/([a-zñ])\1+/g, '$1');
    if (sinDobles !== palabra && PALABRAS.has(sinDobles))
      encontradas.add(sinDobles);
  }

  const conBordes = ` ${normal} `;
  for (const frase of FRASES) {
    if (conBordes.includes(` ${frase} `)) encontradas.add(frase);
  }

  return [...encontradas];
}

/** Si el texto tiene lenguaje que no se publica. */
export function isInappropriate(text: string): boolean {
  return findInappropriate(text).length > 0;
}

/**
 * Si el texto deja un dato de contacto: link, dominio, mail, usuario o teléfono.
 * Las respuestas públicas del profesional no pueden llevarlos (publicidad o
 * contacto por fuera de la plataforma). Corre sobre el texto sin invisibles.
 */
export function containsContactInfo(text: string): boolean {
  const t = text.normalize('NFKC').replace(/\p{Cf}/gu, '');
  if (/https?:\/\/|www\s*\.|\bwa\.me\b|\bt\.me\b/i.test(t)) return true;
  if (/[\w.+-]+\s*@\s*[\w-]+/.test(t)) return true;
  if (
    /(?<![\w.])[a-z0-9-]+\s*\.\s*(?:com|net|org|io|ar|app|me|info|biz|co)\b/i.test(
      t,
    )
  )
    return true;
  // Ocho o más dígitos seguidos, aunque estén separados por espacios, puntos,
  // guiones o paréntesis ("11 5555-1234", "+54 9 11 5555 1234").
  // Las fechas completas (12.11.2026, 12/11/2026) no cuentan como teléfono.
  const sinFechas = t.replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, ' ');
  return /\d{8,}/.test(sinFechas.replace(/[\s.\-()]/g, ''));
}
