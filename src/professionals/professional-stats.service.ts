import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  addDays,
  toLocalDateTime,
  todayInArgentina,
} from '../common/time/argentina-time';
import { resolvePeriod } from '../common/time/period';
import { PrismaService } from '../prisma/prisma.service';

/** Meses que abarca el período por defecto: el actual y los dos anteriores. */
export const DEFAULT_STATS_MONTHS = 3;

/** Turnos del período, por cómo terminaron. */
export interface StatsTurnos {
  completados: number;
  noAsistio: number;
  cancelados: number;
  /** Reservas que no se pagaron a tiempo y se liberaron solas. */
  liberados: number;
  /** Confirmados que todavía no llegaron (`scheduled_at` posterior a ahora). */
  porVenir: number;
}

/** Una tasa con su base, para mostrar "8,0 % · 2 de 25". */
export interface StatsTasa {
  /** Porcentaje con un decimal: 8 → 8 %, 10.7 → 10,7 %. */
  porcentaje: number;
  numerador: number;
  denominador: number;
}

export interface ProfessionalStats {
  from: string;
  to: string;
  turnos: StatsTurnos;
  tasas: {
    /** `null` sin turnos que hayan llegado a su fecha: no es un 0 %. */
    cancelacion: StatsTasa | null;
    /** `null` sin turnos atendidos ni ausencias: no es un 0 %. */
    ausentismo: StatsTasa | null;
  };
  /** Consultas completadas por mes (`YYYY-MM`, Argentina), con los meses en 0. */
  consultasPorMes: { mes: string; consultas: number }[];
  pacientes: {
    /** Pacientes con al menos una consulta completada en el período. */
    unicos: number;
    /** De esos, los que tuvieron más de una. */
    recurrentes: number;
  };
  resenas: {
    /** Promedio con un decimal; `null` sin reseñas. */
    promedio: number | null;
    cantidad: number;
    /** Reseñas del período que todavía no tienen respuesta del profesional. */
    sinResponder: number;
  };
}

/**
 * "Mi actividad" del profesional (ENG-196): cuántas consultas hizo, cuántas se
 * cayeron y cómo lo califican en un período.
 *
 * ## Período
 *
 * `?from&to` en días de Argentina, inclusivos (ver `resolvePeriod`). Sin
 * fechas, los últimos {@link DEFAULT_STATS_MONTHS} meses calendario **enteros**,
 * el actual incluido hasta su último día: así el gráfico por mes muestra tres
 * barras completas y los confirmados de lo que queda del mes cuentan como "por
 * venir".
 *
 * ## Qué cuenta en cada número
 *
 * - **Turnos**: por `scheduled_at` (la fecha del turno, no la de la reserva).
 *   Los reservados sin pagar no se cuentan: todavía no son un turno. Los
 *   confirmados ya pasados que nadie cerró tampoco: no se sabe cómo terminaron.
 * - **Tasa de cancelación** = cancelados / (completados + no asistió +
 *   cancelados). Es "de los turnos que llegaron a su fecha o se cayeron antes,
 *   cuántos se cancelaron", sin importar quién canceló. Los liberados quedan
 *   afuera: nunca se pagaron, así que no son una cancelación.
 * - **Ausentismo** = no asistió / (completados + no asistió). Es "de los turnos
 *   a los que había que ir, a cuántos no fue el paciente".
 * - Si el denominador es 0 la tasa es `null`, no 0 %: sin turnos no hay tasa.
 * - **Pacientes**: únicos con al menos una consulta completada en el período;
 *   recurrentes, los que tuvieron más de una.
 * - **Reseñas**: solo las aprobadas, por fecha de creación de la reseña (no del
 *   turno). "Sin responder" son las del período sin respuesta del profesional.
 */
@Injectable()
export class ProfessionalStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    professionalId: string,
    query: { from?: string; to?: string },
    now: Date = new Date(),
  ): Promise<ProfessionalStats> {
    const period = resolvePeriod(
      query.from,
      query.to,
      lastMonths(DEFAULT_STATS_MONTHS, now),
    );

    const professional = await this.prisma.professional.findUnique({
      where: { profile_id: professionalId },
      select: { profile_id: true },
    });
    if (!professional) {
      throw new ForbiddenException(
        'Solo los profesionales tienen resumen de actividad.',
      );
    }

    const turnosDelPeriodo = {
      professional_id: professionalId,
      scheduled_at: { gte: period.start, lt: period.end },
    };
    const resenasDelPeriodo = {
      professional_id: professionalId,
      status: 'APROBADA' as const,
      created_at: { gte: period.start, lt: period.end },
    };

    const [porEstado, porVenir, completadas, rating, sinResponder] =
      await Promise.all([
        this.prisma.appointment.groupBy({
          by: ['status'],
          where: turnosDelPeriodo,
          _count: { _all: true },
        }),
        this.prisma.appointment.count({
          where: {
            professional_id: professionalId,
            status: 'CONFIRMADO',
            scheduled_at: {
              gt: now > period.start ? now : period.start,
              lt: period.end,
            },
          },
        }),
        // Para el gráfico por mes y los pacientes: una fila por consulta, sin
        // datos clínicos. Un año de consultas de un profesional son cientos de
        // filas, y agrupar por mes en Argentina en memoria evita SQL a mano.
        this.prisma.appointment.findMany({
          where: { ...turnosDelPeriodo, status: 'COMPLETADO' },
          select: { patient_id: true, scheduled_at: true },
        }),
        this.prisma.review.aggregate({
          where: resenasDelPeriodo,
          _avg: { rating: true },
          _count: { _all: true },
        }),
        this.prisma.review.count({
          where: { ...resenasDelPeriodo, response: { is: null } },
        }),
      ]);

    const contar = (status: string) =>
      porEstado.find((g) => g.status === status)?._count._all ?? 0;
    const turnos: StatsTurnos = {
      completados: contar('COMPLETADO'),
      noAsistio: contar('NO_ASISTIO'),
      cancelados: contar('CANCELADO'),
      liberados: contar('LIBERADO'),
      porVenir,
    };

    const porPaciente = new Map<string, number>();
    const porMes = new Map(
      monthsBetween(period.from, period.to).map((mes) => [mes, 0]),
    );
    for (const c of completadas) {
      porPaciente.set(c.patient_id, (porPaciente.get(c.patient_id) ?? 0) + 1);
      const mes = toLocalDateTime(c.scheduled_at).date.slice(0, 7);
      porMes.set(mes, (porMes.get(mes) ?? 0) + 1);
    }

    const cantidad = rating._count._all;
    return {
      from: period.from,
      to: period.to,
      turnos,
      tasas: {
        cancelacion: tasa(
          turnos.cancelados,
          turnos.completados + turnos.noAsistio + turnos.cancelados,
        ),
        ausentismo: tasa(
          turnos.noAsistio,
          turnos.completados + turnos.noAsistio,
        ),
      },
      consultasPorMes: [...porMes].map(([mes, consultas]) => ({
        mes,
        consultas,
      })),
      pacientes: {
        unicos: porPaciente.size,
        recurrentes: [...porPaciente.values()].filter((n) => n > 1).length,
      },
      resenas: {
        promedio:
          cantidad > 0 ? Math.round((rating._avg.rating ?? 0) * 10) / 10 : null,
        cantidad,
        sinResponder,
      },
    };
  }
}

/** Sin denominador no hay tasa: `null`, que la pantalla muestra como vacío. */
export function tasa(numerador: number, denominador: number): StatsTasa | null {
  if (denominador === 0) return null;
  return {
    porcentaje: Math.round((numerador / denominador) * 1000) / 10,
    numerador,
    denominador,
  };
}

/**
 * Los últimos `months` meses calendario en Argentina, enteros: del 1 del mes
 * más viejo al último día del actual.
 */
export function lastMonths(
  months: number,
  now: Date = new Date(),
): { from: string; to: string } {
  const [year, month] = todayInArgentina(now).split('-').map(Number);
  const inicio = new Date(Date.UTC(year, month - months, 1));
  const siguiente = new Date(Date.UTC(year, month, 1));
  return {
    from: inicio.toISOString().slice(0, 10),
    to: addDays(siguiente.toISOString().slice(0, 10), -1),
  };
}

/** `YYYY-MM` de cada mes que toca el período, en orden. */
export function monthsBetween(from: string, to: string): string[] {
  const meses: string[] = [];
  let [year, month] = from.split('-').map(Number);
  const fin = to.slice(0, 7);
  for (;;) {
    const mes = `${year}-${String(month).padStart(2, '0')}`;
    meses.push(mes);
    if (mes >= fin) return meses;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}
