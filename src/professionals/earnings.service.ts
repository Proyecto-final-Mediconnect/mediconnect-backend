import { ForbiddenException, Injectable } from '@nestjs/common';
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
 * Sin comisiones ni liquidaciones: el cobro va directo a la cuenta de
 * MercadoPago del profesional. Esto solo muestra.
 */
@Injectable()
export class EarningsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    professionalId: string,
    query: { from?: string; to?: string; pagina?: number },
    now: Date = new Date(),
  ): Promise<EarningsView> {
    const period = resolvePeriod(query.from, query.to, currentMonth(now));
    const { currency, rows } = await this.load(professionalId, period);
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
    };
  }

  /** Las mismas filas que la tabla, todas, en CSV para Excel. */
  async exportCsv(
    professionalId: string,
    query: { from?: string; to?: string },
    now: Date = new Date(),
  ): Promise<{ filename: string; csv: string }> {
    const period = resolvePeriod(query.from, query.to, currentMonth(now));
    const { rows } = await this.load(professionalId, period);
    return {
      filename: `cobros-${period.from}-a-${period.to}.csv`,
      csv: toCsv(rows),
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

/**
 * CSV para el Excel en español: `;` como separador y coma decimal, que es lo
 * que Excel espera con la configuración regional de Argentina, y BOM UTF-8 para
 * que abra bien los acentos.
 */
export function toCsv(rows: EarningRow[]): string {
  const celda = (valor: string) =>
    /[";\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
  const monto = (n: number) => n.toFixed(2).replace('.', ',');
  const encabezado = [
    'Fecha del cobro',
    'Turno',
    'Paciente',
    'Cobrado',
    'Reembolsado',
    'Neto',
    'Estado',
  ];
  const lineas = rows.map((r) =>
    [
      toLocalDateTime(new Date(r.paidAt)).date,
      `${r.date} ${r.startTime}`,
      r.patient,
      monto(r.amount),
      monto(r.refunded),
      monto(r.net),
      r.state === 'REEMBOLSO_PARCIAL'
        ? `Reembolsado ${r.refundPercent} %`
        : ESTADOS[r.state],
    ]
      .map(celda)
      .join(';'),
  );
  return '﻿' + [encabezado.join(';'), ...lineas].join('\r\n') + '\r\n';
}
