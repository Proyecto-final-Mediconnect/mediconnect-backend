import { DEFAULT_CHUNK_WORDS, splitIntoChunks } from './chunks';
import {
  MARKER_PATTERN,
  ReidentificationTable,
  type MarkerKind,
} from './markers';
import { IDENTIFIER_PATTERNS } from './patterns';
import {
  AFTER,
  BEFORE,
  compilePattern,
  digitsPattern,
  escapeRegExp,
  foldText,
  loosePattern,
  onlyDigits,
} from './text-match';

/**
 * ENG-215 — Seudonimización del texto antes de mandarlo a un modelo de IA
 * (ADR-020, punto 4, con lo que agregó el spike ENG-239).
 *
 * Tres capas, en orden, todas de nuestro lado:
 *
 * 1. **Diccionario:** lo que el sistema ya sabe del paciente y del profesional
 *    (nombre, DNI, mail, teléfono, dirección, matrícula). Es la más precisa.
 * 2. **Patrones:** identificadores con forma reconocible (DNI, CUIL, teléfonos,
 *    mails, afiliado, fechas con año, direcciones, URLs, números largos).
 * 3. **Entidades:** un modelo local reconoce personas, lugares y organizaciones
 *    que nadie cargó ("mi hermana Laura", "vivo en Tandil", "el Hospital
 *    Italiano"). Corre sobre pedazos de ~300 palabras, de a uno.
 *
 * Cada hallazgo se reemplaza por un marcador (`[PACIENTE]`, `[PERSONA_1]`,
 * `[DNI_1]`…). La tabla para volver atrás (`ReidentificationTable`) nunca sale
 * de nuestro lado.
 *
 * **Es seudonimización, no anonimización:** una combinación rara de datos que
 * no son identificadores (una enfermedad poco común y un pueblo chico) puede
 * seguir apuntando a alguien. Ver el README del módulo.
 */

/** Lo que el sistema sabe de una persona de la consulta. */
export interface KnownPerson {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
}

export interface KnownIdentities {
  patient: KnownPerson & {
    dni?: string | null;
    address?: string | null;
  };
  professional: KnownPerson & {
    licenseNumber?: string | null;
  };
}

export type EntityKind = 'PERSONA' | 'LUGAR' | 'ORGANIZACION';

export interface RecognizedEntity {
  kind: EntityKind;
  /** El texto tal como aparece en el pedazo. */
  text: string;
}

/**
 * La capa 3. La implementación con el modelo vive en `ai-pipeline/`, fuera de la
 * app: el modelo y sus dependencias pesan 1,4 GB y no entran en Render.
 */
export interface EntityRecognizer {
  recognize(chunk: string): Promise<RecognizedEntity[]>;
}

export interface PseudonymizedText {
  /** Lo único que puede ir al proveedor de IA. */
  text: string;
  /** Para reidentificar la respuesta. Nunca sale de nuestro lado. */
  table: ReidentificationTable;
}

/** Quedó un identificador conocido después de las tres capas: no se manda nada. */
export class PseudonymizationLeakError extends Error {
  constructor(kind: MarkerKind) {
    // Dice el tipo, nunca el valor.
    super(`Quedó un dato del tipo ${kind} después de seudonimizar.`);
    this.name = 'PseudonymizationLeakError';
  }
}

/**
 * Palabras que el modelo a veces toma por un nombre y no lo son: los rótulos de
 * quién habla y los tratamientos.
 */
const NOT_A_NAME: ReadonlySet<string> = new Set(
  [
    'paciente',
    'doctor',
    'doctora',
    'dr',
    'dra',
    'medico',
    'medica',
    'licenciado',
    'licenciada',
    'lic',
    'profesional',
    'señor',
    'señora',
    'sr',
    'sra',
  ].map(foldText),
);

const TITLES = '(?:doctor|doctora|dr\\.?|dra\\.?|licenciad[oa]|lic\\.?)\\s+';

interface DictionaryEntry {
  kind: MarkerKind;
  pattern: RegExp;
  /** Para ordenar de lo más largo a lo más corto ("Lucía Fernández" antes que "Lucía"). */
  length: number;
}

const MIN_NAME_PART = 2;

/** Las partes de un nombre que se buscan solas ("María José" → "María", "José"). */
function nameParts(...names: string[]): string[] {
  return names
    .flatMap((name) => name.split(/[\s-]+/))
    .filter((part) => foldText(part).length >= MIN_NAME_PART);
}

function personEntries(
  kind: 'PACIENTE' | 'PROFESIONAL',
  person: KnownPerson,
  sharedParts: ReadonlySet<string>,
  withTitles: boolean,
): DictionaryEntry[] {
  const entries: DictionaryEntry[] = [];
  const full = `${person.firstName} ${person.lastName}`;
  const forms = [full, `${person.lastName} ${person.firstName}`];

  for (const form of forms) {
    entries.push({
      kind,
      pattern: compilePattern(
        `${BEFORE}${withTitles ? `(?:${TITLES})?` : ''}${loosePattern(form, { capitalized: false })}${AFTER}`,
        'giu',
      ),
      length: form.length + (withTitles ? 10 : 0),
    });
  }

  // Un nombre o apellido compuesto, entero ("María José"), antes que sus partes:
  // si no, vuelve como dos marcadores seguidos.
  const compounds = [person.firstName, person.lastName].filter((name) =>
    /[\s-]/.test(name.trim()),
  );
  for (const name of compounds) {
    entries.push({
      kind,
      pattern: compilePattern(
        `${BEFORE}${loosePattern(name, { capitalized: true })}${AFTER}`,
        'gu',
      ),
      length: name.length,
    });
  }

  for (const part of nameParts(person.firstName, person.lastName)) {
    // Una parte que tienen los dos (mismo apellido) no se puede atribuir: la
    // tapa la capa 3 como persona.
    if (sharedParts.has(foldText(part))) continue;
    const name = loosePattern(part, { capitalized: true });
    entries.push({
      kind,
      // Las partes sueltas van con mayúscula: "Paz" es un apellido, "paz" no.
      // El tratamiento, sin importar mayúsculas.
      pattern: compilePattern(
        withTitles
          ? `${BEFORE}(?:(?:[Dd]octora?|[Dd]ra?\\.?|[Ll]icenciad[oa]|[Ll]ic\\.?)\\s+)?${name}${AFTER}`
          : `${BEFORE}${name}${AFTER}`,
        'gu',
      ),
      length: part.length,
    });
  }
  return entries;
}

function literalEntry(
  kind: MarkerKind,
  value: string | null | undefined,
): DictionaryEntry[] {
  if (!value || value.trim().length < 3) return [];
  return [
    {
      kind,
      pattern: compilePattern(
        `${BEFORE}${loosePattern(value, { capitalized: false })}${AFTER}`,
        'giu',
      ),
      length: value.length,
    },
  ];
}

function digitsEntry(
  kind: MarkerKind,
  value: string | null | undefined,
  minDigits: number,
): DictionaryEntry[] {
  const digits = onlyDigits(value ?? '');
  if (digits.length < minDigits) return [];
  const variants = [digits];
  // Un teléfono se dice muchas veces sin el 54, el 9 o la característica: los
  // últimos 8 y los últimos 7 dígitos (los números locales del interior).
  if (kind === 'TELEFONO') {
    for (const n of [10, 8, 7]) {
      if (digits.length > n) variants.push(digits.slice(-n));
    }
  }
  return variants.map((variant) => ({
    kind,
    pattern: compilePattern(
      `(?<![\\d\\[_])${digitsPattern(variant)}(?![\\d\\]_])`,
      'gu',
    ),
    length: variant.length,
  }));
}

function dictionary(known: KnownIdentities): DictionaryEntry[] {
  const patientParts = new Set(
    nameParts(known.patient.firstName, known.patient.lastName).map(foldText),
  );
  const professionalParts = new Set(
    nameParts(known.professional.firstName, known.professional.lastName).map(
      foldText,
    ),
  );
  const shared = new Set(
    [...patientParts].filter((part) => professionalParts.has(part)),
  );

  return [
    ...personEntries('PROFESIONAL', known.professional, shared, true),
    ...personEntries('PACIENTE', known.patient, shared, false),
    ...literalEntry('MAIL', known.patient.email),
    ...literalEntry('MAIL', known.professional.email),
    ...literalEntry('DIRECCION', known.patient.address),
    ...digitsEntry('DNI', known.patient.dni, 7),
    ...digitsEntry('TELEFONO', known.patient.phone, 8),
    ...digitsEntry('TELEFONO', known.professional.phone, 8),
    ...digitsEntry('MATRICULA', known.professional.licenseNumber, 4),
  ].sort((a, b) => b.length - a.length);
}

/** Reemplaza fuera de los marcadores que ya hay. */
function replaceOutsideMarkers(
  text: string,
  pattern: RegExp,
  replacement: (match: string) => string,
): string {
  return text.replace(pattern, (match) =>
    match.includes('[') || match.includes(']') ? match : replacement(match),
  );
}

export class Pseudonymizer {
  constructor(
    private readonly recognizer: EntityRecognizer,
    private readonly chunkWords: number = DEFAULT_CHUNK_WORDS,
  ) {}

  async pseudonymize(
    text: string,
    known: KnownIdentities,
  ): Promise<PseudonymizedText> {
    const table = new ReidentificationTable(
      `${known.patient.firstName} ${known.patient.lastName}`.trim(),
      `${known.professional.firstName} ${known.professional.lastName}`.trim(),
    );
    const entries = dictionary(known);

    // Capa 1.
    let result = text;
    for (const entry of entries) {
      result = replaceOutsideMarkers(result, entry.pattern, (match) =>
        table.markerFor(entry.kind, match),
      );
    }

    // Capa 2.
    for (const [kind, pattern] of IDENTIFIER_PATTERNS) {
      result = replaceOutsideMarkers(result, pattern, (match) =>
        table.markerFor(kind, match),
      );
    }

    // Capa 3: de a un pedazo por vez (ver `chunks.ts`). Cada entidad se tapa en
    // todo el texto, así un nombre que el modelo vio en un pedazo tampoco queda
    // en los otros.
    const found = new Map<string, RecognizedEntity>();
    for (const chunk of splitIntoChunks(result, this.chunkWords)) {
      for (const entity of await this.recognizer.recognize(chunk)) {
        const surface = entity.text.trim();
        if (!this.isReplaceable(surface)) continue;
        found.set(`${entity.kind}|${surface}`, { ...entity, text: surface });
      }
    }
    // Los marcadores se numeran por orden de aparición ([PERSONA_1] es la
    // primera persona que se nombra), pero se reemplaza de lo más largo a lo
    // más corto, para que "Sofía Ibarra" no quede como "Sofía [PERSONA_1]".
    const entities = [...found.values()];
    for (const entity of [...entities].sort(
      (a, b) => result.indexOf(a.text) - result.indexOf(b.text),
    )) {
      table.markerFor(entity.kind, entity.text);
    }
    entities.sort((a, b) => b.text.length - a.text.length);
    for (const entity of entities) {
      const pattern = compilePattern(
        `${BEFORE}${escapeRegExp(entity.text)}${AFTER}`,
        'gu',
      );
      result = replaceOutsideMarkers(result, pattern, (match) =>
        table.markerFor(entity.kind, match),
      );
    }

    this.assertNothingKnownLeft(result, entries);
    return { text: result, table };
  }

  /** Lo que devolvió el modelo y vale la pena tapar. */
  private isReplaceable(surface: string): boolean {
    if (surface.length < MIN_NAME_PART) return false;
    // Lo que ya es un marcador, o un pedazo de uno.
    if (
      /[[\]]/.test(surface) ||
      /^(?:PACIENTE|PROFESIONAL|[A-Z]+_\d+)$/.test(surface)
    ) {
      return false;
    }
    // Solo signos o números: no es un nombre.
    if (!/\p{L}{2}/u.test(surface)) return false;
    return !NOT_A_NAME.has(foldText(surface).replace(/\.$/, ''));
  }

  /**
   * Última barrera: si algo de lo que el sistema conoce sigue a la vista, no se
   * manda. No debería pasar nunca (la capa 1 lo tapó); si pasa, es un bug.
   */
  private assertNothingKnownLeft(text: string, entries: DictionaryEntry[]) {
    const visible = text.replace(MARKER_PATTERN, ' ');
    for (const entry of entries) {
      entry.pattern.lastIndex = 0;
      if (entry.pattern.test(visible)) {
        entry.pattern.lastIndex = 0;
        throw new PseudonymizationLeakError(entry.kind);
      }
    }
  }
}
