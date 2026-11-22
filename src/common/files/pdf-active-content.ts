import { inflateSync } from 'node:zlib';

/**
 * Contenido activo en un PDF (ENG-217, ADR-020 punto 12).
 *
 * Un PDF puede traer código o acciones que el visor ejecuta solo: JavaScript,
 * abrir otro programa o archivo, archivos adjuntos adentro, formularios que
 * mandan datos a un servidor. Un estudio médico no necesita nada de eso, y es
 * justamente lo que usa un PDF malicioso. Se rechaza en la subida, en los
 * documentos del paciente y en los adjuntos del chat.
 *
 * Qué se mira y por qué así:
 *
 * - **Solo los diccionarios del PDF**, que es donde se declaran las acciones
 *   (`/S /JavaScript`, `/Launch`, `/EmbeddedFiles`…). El contenido de los
 *   streams (imágenes, texto de las páginas) es binario y se saltea: buscar
 *   `/JS` en bytes comprimidos daría falsos positivos.
 * - **Los object streams se descomprimen** (`/Type /ObjStm`): desde PDF 1.5 los
 *   diccionarios pueden ir comprimidos ahí adentro, y es el lugar obvio para
 *   esconder una acción. Con tope de tamaño, contra un "zip bomb".
 * - **Los nombres se decodifican** (`/J#61vaScript` es `/JavaScript`).
 * - **Lo que no se puede revisar se rechaza:** un object stream con un filtro
 *   que no sea FlateDecode, uno que no descomprime (un PDF cifrado) o uno que
 *   pasa el tope. Falla cerrado.
 *
 * `/OpenAction` y `/AA` solos **no** se rechazan: Word y LibreOffice ponen un
 * `/OpenAction` para abrir el documento en la primera página. Lo peligroso es
 * la acción que disparan (JavaScript, Launch…), y esa se detecta por su nombre.
 * Los links (`/URI`) tampoco: un informe puede traer un link y no ejecuta nada
 * sin que se lo toque.
 *
 * El escaneo antivirus queda como mejora futura, por costo (ADR-020).
 */

/** Por qué se rechaza un PDF. Va a los logs; al usuario le llega un mensaje. */
export type PdfRisk =
  | 'JAVASCRIPT'
  | 'ABRE_OTRO_ARCHIVO'
  | 'ARCHIVO_EMBEBIDO'
  | 'FORMULARIO_CON_ACCION'
  | 'MULTIMEDIA'
  | 'NO_INSPECCIONABLE';

/** Los nombres de PDF que delatan contenido activo (ISO 32000-1, §12.6). */
const ACTIVE_NAMES = new Map<string, PdfRisk>([
  ['JavaScript', 'JAVASCRIPT'],
  ['JS', 'JAVASCRIPT'],
  ['Launch', 'ABRE_OTRO_ARCHIVO'],
  ['GoToR', 'ABRE_OTRO_ARCHIVO'],
  ['GoToE', 'ABRE_OTRO_ARCHIVO'],
  ['EmbeddedFile', 'ARCHIVO_EMBEBIDO'],
  ['EmbeddedFiles', 'ARCHIVO_EMBEBIDO'],
  ['FileAttachment', 'ARCHIVO_EMBEBIDO'],
  ['SubmitForm', 'FORMULARIO_CON_ACCION'],
  ['ImportData', 'FORMULARIO_CON_ACCION'],
  ['XFA', 'FORMULARIO_CON_ACCION'],
  ['RichMedia', 'MULTIMEDIA'],
]);

/**
 * Tope de lo que se descomprime, sumando todos los object streams. Un PDF de
 * 10 MB con diccionarios normales descomprime a mucho menos; pasarlo es un PDF
 * armado para colgar el servidor.
 */
export const MAX_INFLATED_BYTES = 50 * 1024 * 1024;

/** `>>`, espacios opcionales y la palabra `stream` con su fin de línea. */
const STREAM_START = />>\s*stream(?:\r\n|\n|\r)/g;

/** Un nombre de PDF: `/` y caracteres regulares (ISO 32000-1, §7.3.5). */
const NAME = /\/([^\s/[\]<>(){}%]+)/g;

/**
 * El primer riesgo que encuentra en el PDF, o `null` si no trae contenido
 * activo. Asume que `buffer` ya pasó la firma de bytes (`%PDF`).
 */
export function findPdfActiveContent(buffer: Buffer): PdfRisk | null {
  const text = buffer.toString('latin1');
  const dictionaries: string[] = [];
  let inflated = 0;
  let cursor = 0;

  STREAM_START.lastIndex = 0;
  for (
    let match = STREAM_START.exec(text);
    match;
    match = STREAM_START.exec(text)
  ) {
    const bodyStart = match.index + match[0].length;
    // Lo de antes del stream (incluido su diccionario) se revisa entero.
    dictionaries.push(text.slice(cursor, bodyStart));

    const end = text.indexOf('endstream', bodyStart);
    const bodyEnd = end === -1 ? text.length : end;
    // El diccionario del stream: desde el `N 0 obj` que lo abre.
    const header = text.slice(
      Math.max(0, text.lastIndexOf('obj', match.index)),
      match.index,
    );

    if (/\/Type\s*\/ObjStm\b/.test(header)) {
      const decoded = inflateObjectStream(
        header,
        buffer.subarray(bodyStart, bodyEnd),
        MAX_INFLATED_BYTES - inflated,
      );
      if (decoded === null) return 'NO_INSPECCIONABLE';
      inflated += decoded.length;
      dictionaries.push(decoded.toString('latin1'));
    }

    cursor = end === -1 ? text.length : end;
    STREAM_START.lastIndex = cursor;
  }
  dictionaries.push(text.slice(cursor));

  for (const chunk of dictionaries) {
    NAME.lastIndex = 0;
    for (let name = NAME.exec(chunk); name; name = NAME.exec(chunk)) {
      const risk = ACTIVE_NAMES.get(decodeName(name[1]));
      if (risk) return risk;
    }
  }
  return null;
}

/**
 * Descomprime un object stream. Solo FlateDecode y sin predictor, que es como
 * los arma cualquier generador; cualquier otra cosa (o un stream cifrado, que
 * no descomprime) devuelve `null`.
 */
function inflateObjectStream(
  header: string,
  body: Buffer,
  budget: number,
): Buffer | null {
  const filter = /\/Filter\s*(\[\s*\/FlateDecode\s*\]|\/FlateDecode\b)/.test(
    header,
  );
  if (!filter || /\/DecodeParms\b/.test(header) || budget <= 0) return null;
  try {
    return inflateSync(body, { maxOutputLength: budget });
  } catch {
    return null;
  }
}

/** `#xx` es un byte en hexadecimal dentro de un nombre: `/J#61vaScript`. */
function decodeName(raw: string): string {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * El mensaje para quien subió el PDF. Imprimirlo como PDF desde el visor arma
 * un archivo nuevo, sin acciones ni adjuntos: es la salida que tiene a mano.
 */
export function pdfRiskMessage(risk: PdfRisk): string {
  return risk === 'NO_INSPECCIONABLE'
    ? 'No pudimos revisar ese PDF (por ejemplo, porque está protegido con contraseña). Abrilo, imprimilo como PDF y usá esa copia.'
    : 'Ese PDF trae contenido activo (como JavaScript o archivos adjuntos) y no lo aceptamos por seguridad. Abrilo, imprimilo como PDF y usá esa copia.';
}
