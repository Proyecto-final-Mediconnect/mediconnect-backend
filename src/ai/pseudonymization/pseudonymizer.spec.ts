import { inspect } from 'node:util';
import { splitIntoChunks } from './chunks';
import { PSEUDONYMIZATION_CASES } from './fixtures';
import { MARKER_PATTERN } from './markers';
import { IDENTIFIER_PATTERNS } from './patterns';
import {
  Pseudonymizer,
  type EntityRecognizer,
  type KnownIdentities,
  type RecognizedEntity,
} from './pseudonymizer';

/**
 * Un reconocedor de mentira: "encuentra" las entidades que le dicen, si están en
 * el pedazo que recibe. Registra cada pedazo para ver cómo se partió el texto.
 */
function fakeRecognizer(entities: RecognizedEntity[]) {
  const chunks: string[] = [];
  const recognizer: EntityRecognizer = {
    recognize: (chunk) => {
      chunks.push(chunk);
      return Promise.resolve(
        entities.filter((entity) => chunk.includes(entity.text)),
      );
    },
  };
  return { recognizer, chunks };
}

const KNOWN: KnownIdentities = PSEUDONYMIZATION_CASES[0].known;

/** ENG-215 — seudonimización en tres capas. */
describe('Pseudonymizer', () => {
  describe.each(PSEUDONYMIZATION_CASES)('caso: $name', (testCase) => {
    it('no deja ningún identificador a la vista ni tapa datos clínicos', async () => {
      const { recognizer } = fakeRecognizer(testCase.entities);
      const { text } = await new Pseudonymizer(recognizer).pseudonymize(
        testCase.transcript,
        testCase.known,
      );

      for (const value of testCase.mustHide) {
        expect({ value, visible: text.includes(value) }).toEqual({
          value,
          visible: false,
        });
      }
      for (const value of testCase.mustKeep) {
        expect({ value, kept: text.includes(value) }).toEqual({
          value,
          kept: true,
        });
      }
    });

    it('reidentificar devuelve el texto original, salvo los nombres canónicos', async () => {
      const { recognizer } = fakeRecognizer(testCase.entities);
      const { text, table } = await new Pseudonymizer(recognizer).pseudonymize(
        testCase.transcript,
        testCase.known,
      );

      const back = table.reidentify(text);
      for (const value of [...testCase.mustKeep]) {
        expect(back).toContain(value);
      }
      expect(back.match(MARKER_PATTERN)).toBeNull();
    });
  });

  it('el mismo dato siempre da el mismo marcador, y datos distintos, marcadores distintos', async () => {
    const { recognizer } = fakeRecognizer([
      { kind: 'PERSONA', text: 'Laura' },
      { kind: 'PERSONA', text: 'Roberto' },
    ]);
    const { text } = await new Pseudonymizer(recognizer).pseudonymize(
      'Laura vino con Roberto. Después Laura se fue. Mi DNI es 30.123.456, o sea 30123456. El de Roberto, 28.111.222.',
      KNOWN,
    );
    expect(text).toBe(
      '[PERSONA_1] vino con [PERSONA_2]. Después [PERSONA_1] se fue. Mi DNI es [DNI_1], o sea [DNI_1]. El de [PERSONA_2], [DNI_2].',
    );
  });

  it('el paciente y el profesional vuelven con el nombre completo', async () => {
    const { recognizer } = fakeRecognizer([]);
    const { text, table } = await new Pseudonymizer(recognizer).pseudonymize(
      'Doctor Gómez: Hola Lucía.',
      KNOWN,
    );
    expect(text).toBe('[PROFESIONAL]: Hola [PACIENTE].');
    expect(table.reidentify('[PACIENTE] consulta con [PROFESIONAL].')).toBe(
      'Lucía Fernández consulta con Martín Gómez.',
    );
  });

  it('la respuesta del modelo se reidentifica aunque cambie el orden, y un marcador inventado queda como está', async () => {
    const { recognizer } = fakeRecognizer([{ kind: 'LUGAR', text: 'Tandil' }]);
    const { table } = await new Pseudonymizer(recognizer).pseudonymize(
      'Vivo en Tandil. Mi DNI es 30.123.456.',
      KNOWN,
    );
    expect(
      table.reidentify(
        'Paciente [PACIENTE] (DNI [DNI_1]), de [LUGAR_1]. Ver [LUGAR_9].',
      ),
    ).toBe(
      'Paciente Lucía Fernández (DNI 30.123.456), de Tandil. Ver [LUGAR_9].',
    );
  });

  it('un nombre que el modelo vio en un pedazo se tapa también en los otros', async () => {
    const relleno = 'me duele la espalda al caminar. '.repeat(60);
    // El reconocedor solo lo "ve" en el primer pedazo.
    let first = true;
    const recognizer: EntityRecognizer = {
      recognize: () => {
        const found: RecognizedEntity[] = first
          ? [{ kind: 'PERSONA', text: 'Esteban' }]
          : [];
        first = false;
        return Promise.resolve(found);
      },
    };
    const { text } = await new Pseudonymizer(recognizer, 50).pseudonymize(
      `Esteban me acompañó. ${relleno}Al final volvió Esteban.`,
      KNOWN,
    );
    expect(text).not.toContain('Esteban');
    expect(text.match(/\[PERSONA_1\]/g)).toHaveLength(2);
  });

  it('procesa el texto en pedazos de hasta 300 palabras, de a uno', async () => {
    const { recognizer, chunks } = fakeRecognizer([]);
    const largo = 'Paciente: me duele la espalda cuando me levanto. '.repeat(
      200,
    );
    await new Pseudonymizer(recognizer).pseudonymize(largo, KNOWN);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(
        300,
      );
    }
  });

  it('ignora lo que el modelo devuelve y no es un nombre: rótulos, marcadores y números', async () => {
    const { recognizer } = fakeRecognizer([
      { kind: 'PERSONA', text: 'Paciente' },
      { kind: 'PERSONA', text: 'Doctor' },
      { kind: 'PERSONA', text: '[PACIENTE]' },
      { kind: 'PERSONA', text: 'PACIENTE' },
      { kind: 'ORGANIZACION', text: '400' },
    ]);
    const { text } = await new Pseudonymizer(recognizer).pseudonymize(
      'Paciente: Doctor, ¿tomo 400 mg? Soy Lucía.',
      KNOWN,
    );
    expect(text).toBe('Paciente: Doctor, ¿tomo 400 mg? Soy [PACIENTE].');
  });

  it('un apellido que comparten paciente y profesional no se atribuye a ninguno: lo tapa la capa 3', async () => {
    const known: KnownIdentities = {
      patient: { firstName: 'Ana', lastName: 'López' },
      professional: { firstName: 'Juan', lastName: 'López' },
    };
    const { recognizer } = fakeRecognizer([{ kind: 'PERSONA', text: 'López' }]);
    const { text } = await new Pseudonymizer(recognizer).pseudonymize(
      'Ana López ve a Juan López. Los López son primos.',
      known,
    );
    expect(text).toBe(
      '[PACIENTE] ve a [PROFESIONAL]. Los [PERSONA_1] son primos.',
    );
  });

  it('la tabla no muestra nada en un log ni en un JSON: solo cuánto se tapó', async () => {
    const { recognizer } = fakeRecognizer([{ kind: 'LUGAR', text: 'Tandil' }]);
    const { table } = await new Pseudonymizer(recognizer).pseudonymize(
      'Vivo en Tandil, mi DNI es 30.123.456 y el de mi hijo 41.222.333.',
      KNOWN,
    );
    const shown = `${inspect(table, { depth: 5, showHidden: true })} ${JSON.stringify(table)}`;
    expect(shown).not.toMatch(/Tandil|30\.123\.456|41\.222\.333|Lucía/);
    expect(table.summary()).toEqual({ DNI: 2, LUGAR: 1 });
  });

  it('cubre teléfonos, mails y fechas en sus formas habituales', async () => {
    const { recognizer } = fakeRecognizer([]);
    const { text } = await new Pseudonymizer(recognizer).pseudonymize(
      'Llamame al +54 9 11 4567-8901 o al 4567 8901, escribí a otra.persona@mail.com. Nació el 1-3-75.',
      KNOWN,
    );
    expect(text).toBe(
      'Llamame al [TELEFONO_1] o al [TELEFONO_2], escribí a [MAIL_1]. Nació el [FECHA_1].',
    );
  });

  it('no toca valores clínicos dictados seguidos ni fechas sin año', async () => {
    const { recognizer } = fakeRecognizer([]);
    const clinico =
      'Presión 120/80, frecuencia 72, saturación 98. Valores 120 80 70 80. Hemoglobina 13,5 y 250.000 plaquetas. Control el 3 de marzo, a los 30 días.';
    const { text } = await new Pseudonymizer(recognizer).pseudonymize(
      clinico,
      KNOWN,
    );
    expect(text).toBe(clinico);
  });
});

describe('sin backtracking catastrófico (ReDoS)', () => {
  // Textos armados para que un patrón mal escrito se recorra una vez por cada
  // carácter. Con 100.000 caracteres, uno cuadrático tarda segundos; uno lineal,
  // milisegundos. El tope es holgado para no fallar en un runner lento.
  const N = 100_000;
  const ADVERSARIAL = [
    'a'.repeat(N),
    `${'a.'.repeat(N / 2)}@`,
    `${'a-'.repeat(N / 2)}@b`,
    `calle ${'Abc '.repeat(N / 4)}`,
    `calle ${'a'.repeat(N)}`,
    `${'1'.repeat(N)}x`,
    `${'1 '.repeat(N / 2)}x`,
    `${'1-'.repeat(N / 2)}x`,
    '1.'.repeat(N / 2),
    `afiliado ${'1 '.repeat(N / 2)}x`,
    `dni es ${'es '.repeat(N / 3)}`,
    `www.${'a'.repeat(N)}`,
    `14 de enero de ${'1'.repeat(N)}`,
  ];
  const LIMIT_MS = 1_000;

  it.each(IDENTIFIER_PATTERNS.map(([kind, pattern], i) => [i, kind, pattern]))(
    'patrón %i (%s)',
    (_i, _kind, pattern) => {
      for (const text of ADVERSARIAL) {
        const start = performance.now();
        text.replace(pattern, '');
        expect(performance.now() - start).toBeLessThan(LIMIT_MS);
      }
    },
  );

  it('el diccionario, con todos los datos cargados', async () => {
    const { recognizer } = fakeRecognizer([]);
    const pseudonymizer = new Pseudonymizer(recognizer, 300);
    for (const text of ADVERSARIAL) {
      const start = performance.now();
      await pseudonymizer.pseudonymize(text, KNOWN);
      expect(performance.now() - start).toBeLessThan(LIMIT_MS * 3);
    }
  });
});

describe('splitIntoChunks', () => {
  it('no corta oraciones y respeta el tope', () => {
    const texto =
      'Una oración corta. Otra oración un poco más larga que la anterior! ¿Y una pregunta?';
    const chunks = splitIntoChunks(texto, 10);
    expect(chunks.join('')).toBe(texto);
    for (const chunk of chunks) {
      expect(chunk.trim()).toMatch(/[.!?]$/);
    }
  });

  it('una oración más larga que el tope se corta por palabras sin perder texto', () => {
    const texto = `${'palabra '.repeat(25)}fin.`;
    const chunks = splitIntoChunks(texto, 10);
    expect(chunks.join('')).toBe(texto);
    for (const chunk of chunks) {
      expect(chunk.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(10);
    }
  });

  it('un texto vacío no da pedazos', () => {
    expect(splitIntoChunks('')).toEqual([]);
  });
});
