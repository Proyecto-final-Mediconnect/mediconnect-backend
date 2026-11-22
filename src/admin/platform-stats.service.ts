import { Injectable } from '@nestjs/common';
import { resolvePeriod } from '../common/time/period';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_STATS_MONTHS,
  lastMonths,
  monthsBetween,
} from '../professionals/professional-stats.service';

/** Cuántas especialidades se listan: las que más profesionales validados tienen. */
export const TOP_SPECIALTIES = 8;

const ZONA = 'America/Argentina/Buenos_Aires';

/** La última verificación de la cadena de hash de la historia clínica (ENG-85). */
export interface IntegritySummary {
  /** ISO-8601. */
  at: string;
  /** `OK`, `INCONSISTENT`, `ANCHOR_REGRESSION` o `ERROR`. */
  status: string;
  inconsistencies: number;
  patientsChecked: number | null;
  entriesChecked: number | null;
}

/**
 * Las métricas de la plataforma para el administrador (ENG-195). **Solo
 * agregados**: conteos y montos, nunca un dato que identifique a una persona.
 */
export interface PlatformStats {
  from: string;
  to: string;
  /** Totales al día de hoy, sin las cuentas dadas de baja. */
  usuarios: {
    pacientes: number;
    profesionales: number;
    /** Registrados dentro del período. */
    nuevos: number;
  };
  profesionales: {
    validados: number;
    pendientes: number;
    rechazados: number;
    suspendidos: number;
    /** De los validados, por especialidad, de la que más tiene a la que menos. */
    porEspecialidad: { especialidad: string; profesionales: number }[];
  };
  /** Turnos del período, por la fecha del turno. */
  turnos: {
    total: number;
    completados: number;
    cancelados: number;
    noAsistio: number;
    /** Reservas que se liberaron solas por no pagarse. */
    liberados: number;
    /** Confirmados, a reprogramar o sin pagar: todavía no se resolvieron. */
    pendientes: number;
    /** `YYYY-MM` en hora de Argentina, con los meses en 0. */
    porMes: { mes: string; turnos: number; completados: number }[];
  };
  /** Plata del período: cobros por fecha de acreditación, reembolsos por fecha de proceso. */
  cobros: {
    moneda: 'ARS';
    cobrado: number;
    reembolsado: number;
    neto: number;
    pagos: number;
  };
  resenas: { cantidad: number; promedio: number | null };
  /** La última corrida de la verificación semanal, o `null` si nunca corrió. */
  integridad: IntegritySummary | null;
}

const PENDIENTES = ['CONFIRMADO', 'A_REPROGRAMAR', 'RESERVADO_SIN_PAGAR'];

/**
 * El panel de plataforma del administrador (ENG-195, ENG-220): cómo se usa
 * MediConnect y si la historia clínica sigue íntegra, sin tener que pedir
 * consultas a la base.
 *
 * El período es el mismo que el de "Mi actividad" (`resolvePeriod`, en días de
 * Argentina, hasta 366 días): por defecto, los últimos 3 meses. Los meses se
 * agrupan en hora de Argentina, así un turno del 31 a las 22:00 no cae en el
 * mes siguiente.
 */
@Injectable()
export class PlatformStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    query: { from?: string; to?: string },
    now: Date = new Date(),
  ): Promise<PlatformStats> {
    const period = resolvePeriod(
      query.from,
      query.to,
      lastMonths(DEFAULT_STATS_MONTHS, now),
    );
    const enPeriodo = { gte: period.start, lt: period.end };
    const activos = { deleted_at: null };

    const [
      roles,
      nuevos,
      estados,
      especialidades,
      turnosPorEstado,
      turnosPorMes,
      cobrado,
      reembolsado,
      resenas,
      ultimaVerificacion,
    ] = await Promise.all([
      this.prisma.profile.groupBy({
        by: ['role'],
        where: activos,
        _count: { _all: true },
      }),
      this.prisma.profile.count({
        where: {
          ...activos,
          role: { in: ['PACIENTE', 'PROFESIONAL'] },
          created_at: enPeriodo,
        },
      }),
      this.prisma.professional.groupBy({
        by: ['status'],
        where: { profile: activos },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ especialidad: string; profesionales: number }[]>`
        select s.name as especialidad, count(*)::int as profesionales
          from public.professional_specialties ps
          join public.specialties s on s.id = ps.specialty_id
          join public.professionals p on p.profile_id = ps.professional_id
          join public.profiles pr on pr.id = p.profile_id
         where p.status = 'VALIDADO'::professional_status
           and pr.deleted_at is null
         group by s.name
         order by profesionales desc, s.name asc
         limit ${TOP_SPECIALTIES}`,
      this.prisma.appointment.groupBy({
        by: ['status'],
        where: { scheduled_at: enPeriodo },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<
        { mes: string; turnos: number; completados: number }[]
      >`
        select to_char(scheduled_at at time zone ${ZONA}, 'YYYY-MM') as mes,
               count(*)::int as turnos,
               count(*) filter (where status = 'COMPLETADO'::appointment_status)::int as completados
          from public.appointments
         where scheduled_at >= ${period.start}
           and scheduled_at < ${period.end}
         group by 1`,
      this.prisma.payment.aggregate({
        where: { status: 'APROBADO', confirmed_at: enPeriodo },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.refund.aggregate({
        where: { status: 'PROCESADO', processed_at: enPeriodo },
        _sum: { amount: true },
      }),
      this.prisma.review.aggregate({
        where: { status: 'APROBADA', created_at: enPeriodo },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      this.prisma.integrityCheck.findFirst({
        orderBy: { run_at: 'desc' },
        select: {
          run_at: true,
          status: true,
          inconsistencies_found: true,
          details: true,
        },
      }),
    ]);

    const rol = (r: string) =>
      roles.find((x) => x.role === r)?._count._all ?? 0;
    const estado = (s: string) =>
      estados.find((x) => x.status === s)?._count._all ?? 0;
    const turnosEn = (...s: string[]) =>
      turnosPorEstado
        .filter((x) => s.includes(x.status))
        .reduce((n, x) => n + x._count._all, 0);

    const porMes = new Map(
      monthsBetween(period.from, period.to).map((mes) => [
        mes,
        { mes, turnos: 0, completados: 0 },
      ]),
    );
    for (const fila of turnosPorMes) {
      if (porMes.has(fila.mes)) porMes.set(fila.mes, fila);
    }

    const cobradoTotal = Number(cobrado._sum.amount ?? 0);
    const reembolsadoTotal = Number(reembolsado._sum.amount ?? 0);
    const promedio = resenas._avg.rating;

    return {
      from: period.from,
      to: period.to,
      usuarios: {
        pacientes: rol('PACIENTE'),
        profesionales: rol('PROFESIONAL'),
        nuevos,
      },
      profesionales: {
        validados: estado('VALIDADO'),
        pendientes: estado('PENDIENTE_VALIDACION_MATRICULA'),
        rechazados: estado('RECHAZADO'),
        suspendidos: estado('SUSPENDIDO'),
        porEspecialidad: especialidades,
      },
      turnos: {
        total: turnosEn(
          'COMPLETADO',
          'CANCELADO',
          'NO_ASISTIO',
          'LIBERADO',
          ...PENDIENTES,
        ),
        completados: turnosEn('COMPLETADO'),
        cancelados: turnosEn('CANCELADO'),
        noAsistio: turnosEn('NO_ASISTIO'),
        liberados: turnosEn('LIBERADO'),
        pendientes: turnosEn(...PENDIENTES),
        porMes: [...porMes.values()],
      },
      cobros: {
        moneda: 'ARS',
        cobrado: cobradoTotal,
        reembolsado: reembolsadoTotal,
        neto: Math.round((cobradoTotal - reembolsadoTotal) * 100) / 100,
        pagos: cobrado._count._all,
      },
      resenas: {
        cantidad: resenas._count._all,
        promedio: promedio == null ? null : Math.round(promedio * 10) / 10,
      },
      integridad: ultimaVerificacion
        ? {
            at: ultimaVerificacion.run_at.toISOString(),
            status: ultimaVerificacion.status,
            inconsistencies: ultimaVerificacion.inconsistencies_found,
            patientsChecked: numero(
              ultimaVerificacion.details,
              'patients_checked',
            ),
            entriesChecked: numero(
              ultimaVerificacion.details,
              'entries_checked',
            ),
          }
        : null,
    };
  }
}

/** Un número de `details` (jsonb), sin confiar en su forma. */
function numero(details: unknown, key: string): number | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null;
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
