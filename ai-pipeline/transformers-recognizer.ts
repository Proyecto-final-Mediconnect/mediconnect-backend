// ENG-215 — La capa 3 de la seudonimización: reconocimiento de entidades con un
// modelo local (ADR-020, punto 4). Vive acá y no en `src/` porque el modelo y sus
// dependencias pesan ~1,4 GB: no entran en el build ni en la memoria de Render.
//
// El modelo corre en la máquina que ejecuta el pipeline (GitHub Actions): el
// texto no sale a ningún servicio. Se baja de Hugging Face la primera vez y queda
// en la caché (`HF_CACHE_DIR`, que el workflow guarda entre corridas).

import { env, pipeline } from '@huggingface/transformers';
import type {
  EntityKind,
  EntityRecognizer,
  RecognizedEntity,
} from '../src/ai/pseudonymization/pseudonymizer';

/** Multilingüe (incluye español), con personas, lugares y organizaciones. */
export const NER_MODEL = 'Xenova/distilbert-base-multilingual-cased-ner-hrl';

const KINDS: Readonly<Record<string, EntityKind>> = {
  PER: 'PERSONA',
  LOC: 'LUGAR',
  ORG: 'ORGANIZACION',
};

interface NerToken {
  entity: string;
  score: number;
  index: number;
  word: string;
}

type NerPipeline = (
  text: string,
  options: { ignore_labels: string[] },
) => Promise<NerToken[]>;

interface Span {
  kind: EntityKind;
  start: number;
  end: number;
  lastIndex: number;
}

export class TransformersRecognizer implements EntityRecognizer {
  private constructor(private readonly ner: NerPipeline) {}

  /**
   * Carga el modelo. **Una sola vez por proceso** (ENG-239): descartarlo no
   * devuelve la memoria y recargarlo la hace crecer.
   */
  static async load(
    model: string = NER_MODEL,
  ): Promise<TransformersRecognizer> {
    env.allowLocalModels = false;
    if (process.env.HF_CACHE_DIR) env.cacheDir = process.env.HF_CACHE_DIR;
    const ner = (await pipeline('token-classification', model, {
      dtype: 'q8',
    })) as unknown as NerPipeline;
    return new TransformersRecognizer(ner);
  }

  async recognize(chunk: string): Promise<RecognizedEntity[]> {
    const tokens = await this.ner(chunk, { ignore_labels: ['O'] });

    // El modelo devuelve pedazos de palabras ("Tan" + "##dil") etiquetados B-/I-.
    // Se ubican en el texto en orden y se juntan los de una misma entidad; el
    // texto de la entidad se toma del pedazo, tal cual (con sus tildes, guiones
    // y espacios), para que después se pueda buscar.
    const spans: Span[] = [];
    let cursor = 0;
    for (const token of tokens) {
      const kind = KINDS[token.entity.replace(/^[BI]-/, '')];
      if (!kind) continue;
      const piece = token.word.replace(/^##/, '');
      const start = chunk.indexOf(piece, cursor);
      if (start === -1) continue;
      const end = start + piece.length;
      cursor = end;

      const last = spans.at(-1);
      const continues =
        last !== undefined &&
        last.kind === kind &&
        token.index === last.lastIndex + 1 &&
        (token.word.startsWith('##') || token.entity.startsWith('I-'));
      if (continues) {
        last.end = end;
        last.lastIndex = token.index;
      } else {
        spans.push({ kind, start, end, lastIndex: token.index });
      }
    }

    // Una entidad que termina en medio de una palabra ("Tand" de "Tandil") se
    // completa hasta el final de la palabra: tapar de más es mejor que dejar
    // la mitad de un nombre a la vista.
    return spans.map(({ kind, start, end }) => {
      let stop = end;
      while (stop < chunk.length && /[\p{L}\p{N}]/u.test(chunk[stop])) stop++;
      return { kind, text: chunk.slice(start, stop) };
    });
  }
}
