import { foldText, onlyDigits } from './text-match';

/** Qué tapa cada marcador. */
export type MarkerKind =
  | 'PACIENTE'
  | 'PROFESIONAL'
  | 'PERSONA'
  | 'LUGAR'
  | 'ORGANIZACION'
  | 'DNI'
  | 'CUIL'
  | 'TELEFONO'
  | 'MAIL'
  | 'DIRECCION'
  | 'FECHA'
  | 'AFILIADO'
  | 'MATRICULA'
  | 'URL'
  | 'NUMERO';

const NUMERIC: ReadonlySet<MarkerKind> = new Set([
  'DNI',
  'CUIL',
  'TELEFONO',
  'AFILIADO',
  'MATRICULA',
  'NUMERO',
]);

/** Cualquier marcador que pueda haber armado este módulo. */
export const MARKER_PATTERN = /\[(?:PACIENTE|PROFESIONAL|[A-Z]+_\d+)\]/g;

/**
 * La tabla de equivalencias de UNA transcripción: marcador → valor original.
 *
 * **Nunca sale de nuestro lado:** ni al proveedor de IA, ni a un log, ni a la
 * base. Se usa para reidentificar el resultado y se descarta. Los valores viven
 * en campos privados de JavaScript (`#`), que ni `console.log` ni
 * `JSON.stringify` muestran: lo único que sale es `summary()`, que dice cuánto
 * se tapó de cada tipo, sin datos.
 */
export class ReidentificationTable {
  readonly #originals = new Map<string, string>();
  readonly #byKey = new Map<string, string>();
  readonly #counters = new Map<MarkerKind, number>();
  readonly #patientName: string;
  readonly #professionalName: string;

  constructor(patientName: string, professionalName: string) {
    this.#patientName = patientName;
    this.#professionalName = professionalName;
  }

  /**
   * El marcador de un valor. El mismo valor (sin importar tildes, mayúsculas ni
   * separadores) siempre da el mismo marcador, así el modelo entiende que se
   * habla de la misma persona o el mismo dato.
   */
  markerFor(kind: MarkerKind, surface: string): string {
    if (kind === 'PACIENTE' || kind === 'PROFESIONAL') return `[${kind}]`;
    const normalized = NUMERIC.has(kind)
      ? onlyDigits(surface)
      : foldText(surface);
    const key = `${kind}|${normalized}`;
    const existing = this.#byKey.get(key);
    if (existing) return existing;

    const n = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, n);
    const marker = `[${kind}_${n}]`;
    this.#byKey.set(key, marker);
    this.#originals.set(marker, surface);
    return marker;
  }

  /**
   * Vuelve a poner los datos en un texto que trae marcadores (el resumen). El
   * paciente y el profesional vuelven con su nombre completo, no con la forma en
   * que se los nombró ("doctor Gómez" vuelve como "Martín Gómez"). Un marcador
   * que no es de esta tabla (el modelo lo inventó) queda como está.
   */
  reidentify(text: string): string {
    return text.replace(MARKER_PATTERN, (marker) => {
      if (marker === '[PACIENTE]') return this.#patientName;
      if (marker === '[PROFESIONAL]') return this.#professionalName;
      return this.#originals.get(marker) ?? marker;
    });
  }

  /** Cuántos valores distintos se taparon de cada tipo. Sin datos: se puede loguear. */
  summary(): Partial<Record<MarkerKind, number>> {
    return Object.fromEntries(this.#counters);
  }

  toJSON(): Partial<Record<MarkerKind, number>> {
    return this.summary();
  }
}
