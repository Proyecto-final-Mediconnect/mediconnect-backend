import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { findPdfActiveContent } from './pdf-active-content';

/** Un PDF mínimo con los objetos dados (sin xref: el inspector no lo necesita). */
function pdf(...objects: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [
    Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'),
  ];
  objects.forEach((obj, i) => {
    parts.push(Buffer.from(`${i + 1} 0 obj\n`, 'latin1'));
    parts.push(typeof obj === 'string' ? Buffer.from(obj, 'latin1') : obj);
    parts.push(Buffer.from('\nendobj\n', 'latin1'));
  });
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}

/** Un objeto con stream: diccionario + cuerpo binario. */
function stream(dict: string, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${body.length} >>\nstream\n`, 'latin1'),
    body,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>';
const PAGES = '<< /Type /Pages /Kids [] /Count 0 >>';

/** ENG-217, ADR-020 punto 12 — PDF con contenido activo. */
describe('findPdfActiveContent', () => {
  it('un PDF común pasa, aunque tenga un /OpenAction a una página y links', () => {
    // Word y LibreOffice abren en la primera página con un /OpenAction: no es
    // una acción que ejecute nada.
    const comun = pdf(
      '<< /Type /Catalog /Pages 2 0 R /OpenAction [3 0 R /XYZ null null 0] >>',
      PAGES,
      '<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://example.com) >> >>',
      stream(
        '/Filter /FlateDecode',
        deflateSync('BT /F1 12 Tf (Hemograma) Tj ET'),
      ),
    );

    expect(findPdfActiveContent(comun)).toBeNull();
  });

  it('rechaza JavaScript en la acción de apertura', () => {
    const malicioso = pdf(
      '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>',
      PAGES,
    );

    expect(findPdfActiveContent(malicioso)).toBe('JAVASCRIPT');
  });

  it('rechaza un nombre ofuscado con #xx', () => {
    const ofuscado = pdf(
      '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /J#61vaScript /J#53 (x) >> >>',
      PAGES,
    );

    expect(findPdfActiveContent(ofuscado)).toBe('JAVASCRIPT');
  });

  it('rechaza lo que viene escondido en un object stream comprimido', () => {
    const escondido = deflateSync(
      '4 0 << /Type /Action /S /Launch /F (cmd.exe) >>',
    );
    const pdfConObjStm = pdf(
      CATALOG,
      PAGES,
      stream('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode', escondido),
    );

    expect(findPdfActiveContent(pdfConObjStm)).toBe('ABRE_OTRO_ARCHIVO');
  });

  it.each([
    [
      'archivos embebidos',
      '<< /Names << /EmbeddedFiles 5 0 R >> >>',
      'ARCHIVO_EMBEBIDO',
    ],
    [
      'un formulario que manda datos',
      '<< /S /SubmitForm /F (https://x) >>',
      'FORMULARIO_CON_ACCION',
    ],
    [
      'un formulario XFA',
      '<< /AcroForm << /XFA 6 0 R >> >>',
      'FORMULARIO_CON_ACCION',
    ],
    ['multimedia', '<< /Subtype /RichMedia >>', 'MULTIMEDIA'],
  ])('rechaza %s', (_, obj, riesgo) => {
    expect(findPdfActiveContent(pdf(CATALOG, PAGES, obj))).toBe(riesgo);
  });

  it('no confunde bytes binarios de una imagen con un nombre', () => {
    // Bytes que, leídos como texto, contienen "/JS " y "/Launch": dentro de un
    // stream que no es de objetos no se miran.
    const binario = Buffer.concat([
      randomBytes(512),
      Buffer.from(' /JS /Launch /JavaScript ', 'latin1'),
      randomBytes(512),
    ]);
    const conImagen = pdf(
      CATALOG,
      PAGES,
      stream('/Type /XObject /Subtype /Image /Filter /DCTDecode', binario),
    );

    expect(findPdfActiveContent(conImagen)).toBeNull();
  });

  it('un object stream que no se puede leer (cifrado) no se puede revisar: se rechaza', () => {
    const cifrado = pdf(
      CATALOG,
      PAGES,
      stream(
        '/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode',
        randomBytes(256),
      ),
    );

    expect(findPdfActiveContent(cifrado)).toBe('NO_INSPECCIONABLE');
  });

  it('un object stream con otro filtro o con predictor tampoco', () => {
    const otroFiltro = pdf(
      CATALOG,
      stream(
        '/Type /ObjStm /N 1 /First 4 /Filter /LZWDecode',
        Buffer.from('xx'),
      ),
    );
    const conPredictor = pdf(
      CATALOG,
      stream(
        '/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /DecodeParms << /Predictor 12 >>',
        deflateSync('4 0 << >>'),
      ),
    );

    expect(findPdfActiveContent(otroFiltro)).toBe('NO_INSPECCIONABLE');
    expect(findPdfActiveContent(conPredictor)).toBe('NO_INSPECCIONABLE');
  });

  it('corta un zip bomb: no descomprime más que el tope', () => {
    // 60 MB de ceros comprimen a ~60 KB.
    const bomba = deflateSync(Buffer.alloc(60 * 1024 * 1024));
    const pdfBomba = pdf(
      CATALOG,
      stream('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode', bomba),
    );

    expect(findPdfActiveContent(pdfBomba)).toBe('NO_INSPECCIONABLE');
  });

  it('acepta el filtro como arreglo y lee el object stream limpio', () => {
    const limpio = pdf(
      CATALOG,
      stream(
        '/Type /ObjStm /N 1 /First 4 /Filter [/FlateDecode]',
        deflateSync('3 0 << /Type /Page /Parent 2 0 R >>'),
      ),
    );

    expect(findPdfActiveContent(limpio)).toBeNull();
  });
});
