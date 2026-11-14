import ExcelJS from 'exceljs';

/** Content-Type de un `.xlsx`. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Formato de una columna: decide el formato numérico de Excel y la alineación. */
export type ExcelFormat = 'texto' | 'fecha' | 'fechaHora' | 'entero' | 'moneda';

export interface ExcelColumn<T> {
  header: string;
  /** Ancho en caracteres. */
  width: number;
  format?: ExcelFormat;
  value: (row: T) => string | number | Date | null;
}

export interface ExcelReport<T> {
  /** Nombre de la hoja (máximo 31 caracteres). */
  sheet: string;
  /** Primera fila, en grande: "Mis pacientes". */
  title: string;
  /** Líneas debajo del título: de quién es, cuándo se generó, qué filtros. */
  details?: string[];
  columns: ExcelColumn<T>[];
  rows: T[];
}

/** Los colores de MediConnect, en ARGB. */
const COLOR = {
  marca: 'FF0E7C7B',
  titulo: 'FF0B4F6C',
  gris: 'FF64748B',
  linea: 'FFE3EBEE',
  cebra: 'FFF4F8FA',
  blanco: 'FFFFFFFF',
} as const;

const NUM_FMT: Record<ExcelFormat, string | undefined> = {
  texto: undefined,
  fecha: 'dd/mm/yyyy',
  fechaHora: 'dd/mm/yyyy hh:mm',
  entero: '0',
  moneda: '"$" #,##0.00',
};

/**
 * Una fecha y hora de Argentina como `Date` para Excel.
 *
 * Excel no tiene zonas horarias: guarda el número de días y muestra lo que
 * recibió. exceljs escribe los `Date` en UTC, así que se arma un `Date` cuyo
 * UTC *es* la hora de Argentina; si no, una consulta de las 10:00 se vería a
 * las 13:00.
 */
export function excelDate(date: string, time = '00:00'): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm));
}

/**
 * Un reporte en `.xlsx` con la identidad de MediConnect, listo para abrir en
 * Excel: título y detalles arriba, encabezado en verde con filtro, filas con
 * fechas y números de verdad (se pueden ordenar y sumar), panel fijo para que
 * el encabezado no se pierda al bajar, y página horizontal ajustada al ancho
 * para imprimir.
 *
 * Es el reemplazo del CSV: con `;` y coma decimal, el CSV abría bien o mal
 * según la configuración regional de cada Excel.
 */
export async function buildXlsx<T>(report: ExcelReport<T>): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'MediConnect';
  libro.created = new Date();

  const hoja = libro.addWorksheet(report.sheet.slice(0, 31), {
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  hoja.columns = report.columns.map((c) => ({ width: c.width }));
  const ultimaColumna = report.columns.length;

  const titulo = hoja.addRow([report.title]);
  titulo.font = { size: 16, bold: true, color: { argb: COLOR.titulo } };
  titulo.height = 24;
  for (const linea of report.details ?? []) {
    hoja.addRow([linea]).font = { size: 10, color: { argb: COLOR.gris } };
  }
  hoja.addRow([]);

  const encabezado = hoja.addRow(report.columns.map((c) => c.header));
  encabezado.height = 22;
  encabezado.eachCell((celda, i) => {
    celda.font = { bold: true, color: { argb: COLOR.blanco } };
    celda.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: COLOR.marca },
    };
    celda.alignment = {
      vertical: 'middle',
      horizontal: alineacion(report.columns[i - 1].format),
    };
  });
  const filaEncabezado = encabezado.number;

  report.rows.forEach((row, n) => {
    const fila = hoja.addRow(report.columns.map((c) => c.value(row)));
    fila.eachCell({ includeEmpty: true }, (celda, i) => {
      const columna = report.columns[i - 1];
      const formato = NUM_FMT[columna.format ?? 'texto'];
      if (formato) celda.numFmt = formato;
      celda.alignment = {
        vertical: 'middle',
        horizontal: alineacion(columna.format),
      };
      celda.border = {
        bottom: { style: 'thin', color: { argb: COLOR.linea } },
      };
      if (n % 2 === 1) {
        celda.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: COLOR.cebra },
        };
      }
    });
  });

  hoja.views = [{ state: 'frozen', ySplit: filaEncabezado }];
  hoja.autoFilter = {
    from: { row: filaEncabezado, column: 1 },
    to: { row: filaEncabezado, column: ultimaColumna },
  };

  return Buffer.from(await libro.xlsx.writeBuffer());
}

function alineacion(format?: ExcelFormat): 'left' | 'right' | 'center' {
  if (format === 'entero' || format === 'moneda') return 'right';
  if (format === 'fecha' || format === 'fechaHora') return 'center';
  return 'left';
}
