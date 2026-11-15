import { ForbiddenException, Injectable } from '@nestjs/common';
import { buildXlsx, excelDate } from '../common/excel/excel';
import { toLocalDateTime } from '../common/time/argentina-time';
import {
  currentMonth,
  resolvePeriod,
  type ReportPeriod,
} from '../common/time/period';
import { PrismaService } from '../prisma/prisma.service';

/** Filas por página de la tabla. */
export const EARNINGS_PAGE_SIZE = 20;

/** Cómo quedó lo cobrado de un turno. */
export type EarningState =
  | 'COBRADO'
  | 'REEMBOLSO_PARCIAL'
  | 'REEMBOLSADO'
  | 'REEMBOLSO_PENDIENTE';

/** Un cobro, por turno. Solo el nombre del paciente: ningún dato clínico. */
export interface EarningRow {
  appointmentId: string;
  /** Cuándo se acreditó, ISO-8601. Es lo que ubica el cobro en el período. */
  paidAt: string;
  /** Fecha y hora del turno, en Argentina. */
  date: string;
  startTime: string;
  patient: string;
  amount: number;
  /** Lo devuelto: reembolsos procesados. */
  refunded: number;
  /** Reembolsos pedidos que MercadoPago todavía no procesó. */
  refundPending: number;
  net: number;
  state: EarningState;
  /** Porcentaje devuelto, para "Reembolsado 50 %". `null` sin reembolso. */
  refundPercent: number | null;
}

/** Orden de la tabla. Por defecto, lo último que se acreditó primero. */
export type EarningsOrder = 'RECIENTES' | 'ANTIGUOS' | 'MAYOR_MONTO';

/** Filtros de la tabla: recortan las filas, los totales y el Excel por igual. */
export interface EarningsFilters {
  estado?: EarningState;
  /** Parte del nombre del paciente, sin importar mayúsculas ni tildes. */
  paciente?: string;
  orden?: EarningsOrder;
}

export interface EarningsTotals {
  cobrado: number;
  reembolsado: number;
  neto: number;
  pendiente: number;
  turnos: number;
}

export interface EarningsView {
  from: string;
  to: string;
  currency: string;
  totals: EarningsTotals;
  rows: EarningRow[];
  pagina: number;
  hayMas: boolean;
  /** Los pacientes con cobros en el período, sin filtrar: para elegir uno. */
  pacientes: string[];
}

/**
 * "Mis cobros" del profesional (ENG-194).
 *
 * ## Qué cuenta como cobrado
 *
 * Los pagos que MercadoPago acreditó (`APROBADO`, o `REEMBOLSADO` si después se
 * devolvió entero) y que se acreditaron en el período: el período es de
 * **cobro**, no de consulta. Un turno sin pagar o liberado no tiene pago
 * acreditado, así que no aparece.
 *
 * ## Reembolsos
 *
 * Se descuenta solo lo devuelto (`refunds` en `PROCESADO`), sea total o
 * parcial. Uno pedido que todavía no salió va aparte como "pendiente" y no se
 * descuenta del neto hasta que se procese; uno rechazado no devolvió nada.
 *
 * ## Montos
 *
 * Se suman en centavos para no arrastrar errores de punto flotante: con
 * decimales binarios, sumar veinte turnos puede dar ...,9999.
 *
 * ## Filtros
 *
 * Estado, paciente y orden se aplican sobre las filas del período, y los
 * totales y el Excel salen de las filas filtradas: "cuánto le cobré a Fulano en
 * octubre" es una pregunta válida. La lista de pacientes no se filtra, para
 * poder cambiar de uno a otro.
 *
 * Sin comisiones ni liquidaciones: el cobro va directo a la cuenta de
 * MercadoPago del profesional. Esto solo muestra.
 */
@Injectable()
export class EarningsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    professionalId: string,
    query: { from?: string; to?: string; pagina?: number } & EarningsFilters,
    now: Date = new Date(),
  ): Promise<EarningsView> {
    const period = resolvePeriod(query.from, query.to, currentMonth(now));
    const { currency, rows: todas } = await this.load(professionalId, period);
    const rows = filterRows(todas, query);
    const pagina = query.pagina ?? 1;
    const desde = (pagina - 1) * EARNINGS_PAGE_SIZE;

    return {
      from: period.from,
      to: period.to,
      currency,
      totals: totalsOf(rows),
      rows: rows.slice(desde, desde + EARNINGS_PAGE_SIZE),
      pagina,
      hayMas: rows.length > desde + EARNINGS_PAGE_SIZE,
      pacientes: [...new Set(todas.map((r) => r.patient))].sort((a, b) =>
        a.localeCompare(b, 'es'),
      ),
    };
  }

  /** Las mismas filas que la tabla, todas, en un `.xlsx` con los totales. */
  async exportXlsx(
    professionalId: string,
    query: { from?: string; to?: string } & EarningsFilters,
    now: Date = new Date(),
  ): Promise<{ filename: string; xlsx: Buffer }> {
    const period = resolvePeriod(query.from, query.to, currentMonth(now));
    const { rows } = await this.load(professionalId, period);
    const pro = await this.prisma.professional.findUnique({
      where: { profile_id: professionalId },
      select: { first_name: true, last_name: true },
    });
    return {
      filename: `mis-cobros-${period.from}-a-${period.to}.xlsx`,
      xlsx: await toXlsx(filterRows(rows, query), {
        profesional: [pro?.first_name, pro?.last_name]
          .filter(Boolean)
          .join(' '),
        periodo: period,
        filtros: describeFilters(query),
        now,
      }),
    };
  }

  private async load(
    professionalId: string,
    period: ReportPeriod,
  ): Promise<{ currency: string; rows: EarningRow[] }> {
    const professional = await this.prisma.professional.findUnique({
      where: { profile_id: professionalId },
      select: { currency: true },
    });
    if (!professional) {
      throw new ForbiddenException('Solo los profesionales tienen cobros.');
    }

    const payments = await this.prisma.payment.findMany({
      where: {
        status: { in: ['APROBADO', 'REEMBOLSADO'] },
        confirmed_at: { gte: period.start, lt: period.end },
        appointment: { professional_id: professionalId },
      },
      orderBy: [{ confirmed_at: 'desc' }, { id: 'desc' }],
      select: {
        amount: true,
        confirmed_at: true,
        refunds: { select: { amount: true, status: true } },
        appointment: {
          select: {
            id: true,
            scheduled_at: true,
            patient: { select: { first_name: true, last_name: true } },
          },
        },
      },
    });

    const rows = payments.map((p): EarningRow => {
      const amount = cents(p.amount);
      const refunded = sumCents(
        p.refunds.filter((r) => r.status === 'PROCESADO'),
      );
      const refundPending = sumCents(
        p.refunds.filter((r) => r.status === 'PENDIENTE'),
      );
      const { date, startTime } = toLocalDateTime(p.appointment.scheduled_at);
      return {
        appointmentId: p.appointment.id,
        // `confirmed_at` no es null: el filtro del período lo exige.
        paidAt: (p.confirmed_at as Date).toISOString(),
        date,
        startTime,
        patient:
          `${p.appointment.patient.first_name} ${p.appointment.patient.last_name}`.trim(),
        amount: amount / 100,
        refunded: refunded / 100,
        refundPending: refundPending / 100,
        net: (amount - refunded) / 100,
        state: stateOf(amount, refunded, refundPending),
        refundPercent:
          refunded > 0 ? Math.round((refunded / amount) * 100) : null,
      };
    });

    return { currency: professional.currency, rows };
  }
}

/** Para comparar nombres sin que mayúsculas ni tildes los distingan. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function filterRows(
  rows: EarningRow[],
  { estado, paciente, orden = 'RECIENTES' }: EarningsFilters,
): EarningRow[] {
  const buscado = paciente ? normalizar(paciente) : '';
  const filtradas = rows.filter(
    (r) =>
      (!estado || r.state === estado) &&
      (!buscado || normalizar(r.patient).includes(buscado)),
  );
  // Las filas ya vienen de la más reciente a la más vieja.
  if (orden === 'ANTIGUOS') return filtradas.reverse();
  if (orden === 'MAYOR_MONTO') {
    return filtradas.sort((a, b) => b.net - a.net || b.amount - a.amount);
  }
  return filtradas;
}

function cents(value: { toString(): string } | number): number {
  return Math.round(Number(value) * 100);
}

function sumCents(items: { amount: { toString(): string } }[]): number {
  return items.reduce((total, item) => total + cents(item.amount), 0);
}

function stateOf(
  amount: number,
  refunded: number,
  pending: number,
): EarningState {
  if (refunded >= amount) return 'REEMBOLSADO';
  if (refunded > 0) return 'REEMBOLSO_PARCIAL';
  if (pending > 0) return 'REEMBOLSO_PENDIENTE';
  return 'COBRADO';
}

export function totalsOf(rows: EarningRow[]): EarningsTotals {
  const suma = (key: 'amount' | 'refunded' | 'refundPending') =>
    rows.reduce((total, row) => total + Math.round(row[key] * 100), 0);
  const cobrado = suma('amount');
  const reembolsado = suma('refunded');
  return {
    cobrado: cobrado / 100,
    reembolsado: reembolsado / 100,
    neto: (cobrado - reembolsado) / 100,
    pendiente: suma('refundPending') / 100,
    turnos: rows.length,
  };
}

const ESTADOS: Record<EarningState, string> = {
  COBRADO: 'Cobrado',
  REEMBOLSO_PARCIAL: 'Reembolsado en parte',
  REEMBOLSADO: 'Reembolsado',
  REEMBOLSO_PENDIENTE: 'Reembolso pendiente',
};

const ORDENES: Record<EarningsOrder, string> = {
  RECIENTES: 'lo último cobrado primero',
  ANTIGUOS: 'lo más antiguo primero',
  MAYOR_MONTO: 'mayor neto primero',
};

/** Los filtros en una línea, para que el Excel diga qué recorte es. */
export function describeFilters({
  estado,
  paciente,
  orden = 'RECIENTES',
}: EarningsFilters): string {
  const partes: string[] = [];
  if (estado) partes.push(`estado «${ESTADOS[estado]}»`);
  if (paciente?.trim()) partes.push(`paciente «${paciente.trim()}»`);
  partes.push(`ordenado por ${ORDENES[orden]}`);
  return partes.join(' · ');
}

function fechaAR(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * La tabla en Excel: las mismas columnas que la pantalla, con fechas y montos
 * de verdad (se ordenan, filtran y suman en Excel), en hora de Argentina, y
 * los totales al pie.
 */
export function toXlsx(
  rows: EarningRow[],
  meta: {
    profesional: string;
    periodo: { from: string; to: string };
    filtros: string;
    now: Date;
  },
): Promise<Buffer> {
  const generado = toLocalDateTime(meta.now);
  const totales = totalsOf(rows);
  return buildXlsx({
    sheet: 'Mis cobros',
    title: 'Mis cobros',
    details: [
      [
        meta.profesional,
        `Generado el ${fechaAR(generado.date)} a las ${generado.startTime}`,
      ]
        .filter(Boolean)
        .join(' · '),
      `Cobros del ${fechaAR(meta.periodo.from)} al ${fechaAR(meta.periodo.to)} · ${meta.filtros}`,
    ],
    columns: [
      {
        header: 'Fecha del cobro',
        width: 20,
        format: 'fechaHora',
        value: (r) => {
          const { date, startTime } = toLocalDateTime(new Date(r.paidAt));
          return excelDate(date, startTime);
        },
      },
      {
        header: 'Turno',
        width: 20,
        format: 'fechaHora',
        value: (r) => excelDate(r.date, r.startTime),
      },
      { header: 'Paciente', width: 28, value: (r) => r.patient },
      {
        header: 'Cobrado',
        width: 16,
        format: 'moneda',
        value: (r) => r.amount,
      },
      {
        header: 'Reembolsado',
        width: 16,
        format: 'moneda',
        value: (r) => r.refunded,
      },
      { header: 'Neto', width: 16, format: 'moneda', value: (r) => r.net },
      {
        header: 'Estado',
        width: 24,
        value: (r) =>
          r.state === 'REEMBOLSO_PARCIAL'
            ? `Reembolsado ${r.refundPercent} %`
            : ESTADOS[r.state],
      },
    ],
    rows,
    totals: [
      'Total',
      null,
      `${totales.turnos} ${totales.turnos === 1 ? 'turno' : 'turnos'}`,
      totales.cobrado,
      totales.reembolsado,
      totales.neto,
      totales.pendiente > 0 ? 'Hay reembolsos pendientes' : null,
    ],
  });
}
