/**
 * Parte un texto en pedazos de hasta `maxWords` palabras, sin cortar oraciones.
 *
 * El modelo de entidades lee hasta 512 tokens: con una consulta entera de 30
 * minutos no encontró ningún nombre (ENG-239). Partido en pedazos de ~300
 * palabras, por oración, los encontró todos. Una oración más larga que el tope
 * se corta por palabras.
 */
export const DEFAULT_CHUNK_WORDS = 300;

const SENTENCE = /[^.!?\n]+(?:[.!?]+|\n+|$)|[.!?\n]+/g;

const wordCount = (text: string) =>
  text.split(/\s+/).filter((word) => word.length > 0).length;

export function splitIntoChunks(
  text: string,
  maxWords: number = DEFAULT_CHUNK_WORDS,
): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentWords = 0;

  const flush = () => {
    if (current.trim().length > 0) chunks.push(current);
    current = '';
    currentWords = 0;
  };

  for (const sentence of text.match(SENTENCE) ?? []) {
    const words = wordCount(sentence);
    if (words > maxWords) {
      flush();
      const parts = sentence.split(/(\s+)/);
      for (const part of parts) {
        if (part.trim().length > 0 && currentWords >= maxWords) flush();
        current += part;
        if (part.trim().length > 0) currentWords += 1;
      }
      flush();
      continue;
    }
    if (currentWords + words > maxWords) flush();
    current += sentence;
    currentWords += words;
  }
  flush();
  return chunks;
}
