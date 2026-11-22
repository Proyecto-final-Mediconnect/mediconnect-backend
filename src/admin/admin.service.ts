import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { ProfessionalAccountNoticesService } from '../notifications/professional-account-notices.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_STATS_MONTHS,
  ProfessionalStatsService,
  type ProfessionalStats,
} from '../professionals/professional-stats.service';
import type { DecideLicenseDto } from './dto/decide-license.dto';
import type { LicenseQueueStatus } from './dto/license-queue-query.dto';
import {
  ADMIN_PROFESSIONALS_PAGE_SIZE,
  type ListProfessionalsAdminQueryDto,
  type ProfessionalStatus,
} from './dto/list-professionals-query.dto';

/** El administrador que entra al panel. */
export interface AdminProfile {
  id: string;
  email: string;
  role: 'ADMINISTRADOR';
}

/** Un profesional en la cola de matrículas (ENG-192). */
export interface LicenseQueueItem {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  licenseNumber: string;
  specialties: string[];
  /** ISO-8601: cuándo se registró. */
  registeredAt: string;
  status: LicenseQueueStatus;
  /**
   * La última decisión sobre la matrícula, leída de `audit_logs`. `null` en un
   * pendiente, o en uno que se validó antes de que existiera el panel (por SQL o
   * por el seed).
   */
  decision: { at: string; reason: string | null } | null;
}

/** Un profesional en el listado del administrador (ENG-241). */
export interface AdminProfessionalRow {
  id: string;
  firstName: string;
  lastName: string;
  licenseNumber: string;
  specialties: string[];
  status: ProfessionalStatus;
  /** ISO-8601: cuándo se registró. */
  registeredAt: string;
  /**
   * La actividad de los últimos `DEFAULT_STATS_MONTHS` meses, como en "Mi
   * actividad", y la calificación de todas sus reseñas publicadas.
   */
  activity: {
    completed: number;
    /** Cancelaciones, ausencias y fallas técnicas (ENG-237). */
    incidents: number;
    rating: number | null;
    reviews: number;
  };
}

export interface AdminProfessionalPage {
  items: AdminProfessionalRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** El detalle de un profesional para el administrador (ENG-241). */
export interface AdminProfessionalDetail {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  licenseNumber: string;
  specialties: string[];
  status: ProfessionalStatus;
  registeredAt: string;
  /** Lo que el paciente ve en el catálogo: sin precio no se le puede reservar. */
  consultationPrice: number | null;
  currency: string;
  /** La misma actividad que el profesional ve en "Mi actividad". */
  stats: ProfessionalStats;
}

/** Las acciones de auditoría que cuentan como incidencias, como en "Mi actividad". */
const INCIDENT_ACTIONS = [
  'APPOINTMENT_CANCELLED_BY_PROFESSIONAL',
  'APPOINTMENT_PROFESSIONAL_NO_SHOW',
  'APPOINTMENT_TECHNICAL_FAILURE',
];

/** Acciones de auditoría de la matrícula. `origin` dice quién decidió. */
export const LICENSE_AUDIT_ACTIONS = {
  VALIDADO: 'PROFESSIONAL_LICENSE_VALIDATED',
  RECHAZADO: 'PROFESSIONAL_LICENSE_REJECTED',
} as const;

/**
 * Quién decidió. Hoy siempre el administrador; la validación automática
 * (ENG-218) va a sumar `'AUTOMATICA'`, y esta cola queda como respaldo de lo
 * que la automática no pueda resolver.
 */
export const LICENSE_DECISION_ORIGIN = 'ADMINISTRADOR';

/** Tope de la cola: es un equipo chico revisando altas, no un listado masivo. */
export const LICENSE_QUEUE_LIMIT = 200;

/**
 * Lógica del panel del administrador (ENG-220): quién entra (ENG-240), la
 * validación de matrículas (ENG-192) y el listado y el detalle de los
 * profesionales (ENG-241). La suspensión vive en `ProfessionalSuspensionService`
 * y las métricas de la plataforma (ENG-195), en `PlatformStatsService`.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notices: ProfessionalAccountNoticesService,
    private readonly stats: ProfessionalStatsService,
  ) {}

  async profile(userId: string): Promise<AdminProfile> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    // `RolesGuard` ya leyó el perfil: si desapareció en el medio, es un 404.
    if (!profile) {
      throw new NotFoundException('No se encontró el perfil del usuario.');
    }
    return { id: profile.id, email: profile.email, role: 'ADMINISTRADOR' };
  }

  /**
   * Los profesionales en un estado de matrícula. Los pendientes, del más viejo
   * al más nuevo: el que más esperó va primero. Los decididos, de la decisión
   * más nueva a la más vieja.
   */
  async licenseQueue(status: LicenseQueueStatus): Promise<LicenseQueueItem[]> {
    const pending = status === 'PENDIENTE_VALIDACION_MATRICULA';
    const rows = await this.prisma.professional.findMany({
      where: { status, profile: { deleted_at: null } },
      select: {
        profile_id: true,
        first_name: true,
        last_name: true,
        license_number: true,
        created_at: true,
        status: true,
        profile: { select: { email: true } },
        specialties: { select: { specialty: { select: { name: true } } } },
      },
      orderBy: [
        { created_at: pending ? 'asc' : 'desc' },
        { profile_id: 'asc' },
      ],
      take: LICENSE_QUEUE_LIMIT,
    });

    const decisions = pending
      ? new Map<string, LicenseQueueItem['decision']>()
      : await this.lastDecisions(
          rows.map((r) => r.profile_id),
          status,
        );

    const items: LicenseQueueItem[] = rows.map((row) => ({
      id: row.profile_id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.profile.email,
      licenseNumber: row.license_number,
      specialties: row.specialties.map((s) => s.specialty.name).sort(),
      registeredAt: row.created_at.toISOString(),
      status: row.status as LicenseQueueStatus,
      decision: decisions.get(row.profile_id) ?? null,
    }));

    if (!pending) {
      // La decisión más nueva primero; los que no tienen (validados por SQL o por
      // el seed) quedan al final, por fecha de alta.
      items.sort((a, b) => {
        if (a.decision && b.decision) {
          return b.decision.at.localeCompare(a.decision.at);
        }
        if (a.decision) return -1;
        if (b.decision) return 1;
        return b.registeredAt.localeCompare(a.registeredAt);
      });
    }
    return items;
  }

  /**
   * Valida o rechaza la matrícula de un profesional pendiente.
   *
   * Un `updateMany` condicionado al estado pendiente es el árbitro: si dos
   * administradores deciden a la vez, uno gana y el otro recibe 409, y nunca
   * quedan dos decisiones. El cambio y la auditoría van en la misma
   * transacción. El mail sale después y no deshace la decisión si falla.
   */
  async decideLicense(
    adminId: string,
    professionalId: string,
    dto: DecideLicenseDto,
    now: Date = new Date(),
  ): Promise<{ id: string; status: 'VALIDADO' | 'RECHAZADO' }> {
    const reason = dto.reason?.trim() || null;

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.professional.updateMany({
        where: {
          profile_id: professionalId,
          status: 'PENDIENTE_VALIDACION_MATRICULA',
          profile: { deleted_at: null },
        },
        data: { status: dto.decision, updated_at: now },
      });
      if (count === 0) {
        const exists = await tx.professional.findUnique({
          where: { profile_id: professionalId },
          select: { status: true },
        });
        if (!exists) {
          throw new NotFoundException('No encontramos ese profesional.');
        }
        throw new ConflictException(
          'La matrícula de ese profesional ya tiene una decisión.',
        );
      }

      await tx.auditLog.create({
        data: {
          actor_id: adminId,
          action: LICENSE_AUDIT_ACTIONS[dto.decision],
          resource_type: 'professionals',
          resource_id: professionalId,
          metadata: {
            origin: LICENSE_DECISION_ORIGIN,
            previousStatus: 'PENDIENTE_VALIDACION_MATRICULA',
            ...(reason ? { reason } : {}),
          },
        },
      });
    });

    await this.notices.licenseDecided(professionalId, dto.decision, reason);
    return { id: professionalId, status: dto.decision };
  }

  /**
   * El listado de profesionales (ENG-241): por estado, buscando por nombre o
   * matrícula, de a `ADMIN_PROFESSIONALS_PAGE_SIZE`, ordenado por apellido. La
   * actividad se calcula para la página entera de una vez, no profesional por
   * profesional. Nunca devuelve datos de pacientes.
   */
  async listProfessionals(
    query: ListProfessionalsAdminQueryDto,
    now: Date = new Date(),
  ): Promise<AdminProfessionalPage> {
    const page = query.page ?? 1;
    const q = query.q?.trim();
    const where: Prisma.ProfessionalWhereInput = {
      profile: { deleted_at: null },
      ...(query.status ? { status: query.status } : {}),
      ...(q
        ? {
            OR: [
              { first_name: { contains: q, mode: 'insensitive' } },
              { last_name: { contains: q, mode: 'insensitive' } },
              { license_number: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.professional.count({ where }),
      this.prisma.professional.findMany({
        where,
        select: {
          profile_id: true,
          first_name: true,
          last_name: true,
          license_number: true,
          status: true,
          created_at: true,
          specialties: { select: { specialty: { select: { name: true } } } },
        },
        orderBy: [
          { last_name: 'asc' },
          { first_name: 'asc' },
          { profile_id: 'asc' },
        ],
        skip: (page - 1) * ADMIN_PROFESSIONALS_PAGE_SIZE,
        take: ADMIN_PROFESSIONALS_PAGE_SIZE,
      }),
    ]);

    const activity = await this.activityOf(
      rows.map((r) => r.profile_id),
      now,
    );
    return {
      items: rows.map((row) => ({
        id: row.profile_id,
        firstName: row.first_name,
        lastName: row.last_name,
        licenseNumber: row.license_number,
        specialties: row.specialties.map((sp) => sp.specialty.name).sort(),
        status: row.status,
        registeredAt: row.created_at.toISOString(),
        activity: activity.get(row.profile_id) ?? {
          completed: 0,
          incidents: 0,
          rating: null,
          reviews: 0,
        },
      })),
      total,
      page,
      pageSize: ADMIN_PROFESSIONALS_PAGE_SIZE,
    };
  }

  /** El detalle de un profesional, con la misma actividad que "Mi actividad". */
  async professionalDetail(
    professionalId: string,
    now: Date = new Date(),
  ): Promise<AdminProfessionalDetail> {
    const row = await this.prisma.professional.findUnique({
      where: { profile_id: professionalId },
      select: {
        profile_id: true,
        first_name: true,
        last_name: true,
        license_number: true,
        status: true,
        created_at: true,
        consultation_price: true,
        currency: true,
        profile: { select: { email: true, deleted_at: true } },
        specialties: { select: { specialty: { select: { name: true } } } },
      },
    });
    if (!row || row.profile.deleted_at) {
      throw new NotFoundException('No encontramos ese profesional.');
    }
    return {
      id: row.profile_id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.profile.email,
      licenseNumber: row.license_number,
      specialties: row.specialties.map((sp) => sp.specialty.name).sort(),
      status: row.status,
      registeredAt: row.created_at.toISOString(),
      consultationPrice:
        row.consultation_price === null ? null : Number(row.consultation_price),
      currency: row.currency,
      stats: await this.stats.get(professionalId, {}, now),
    };
  }

  /** La actividad de varios profesionales en tres consultas, no en N. */
  private async activityOf(
    ids: string[],
    now: Date,
  ): Promise<Map<string, AdminProfessionalRow['activity']>> {
    const result = new Map<string, AdminProfessionalRow['activity']>();
    if (ids.length === 0) return result;
    const from = new Date(now);
    from.setUTCMonth(from.getUTCMonth() - DEFAULT_STATS_MONTHS);

    const [completed, incidents, reviews] = await Promise.all([
      this.prisma.appointment.groupBy({
        by: ['professional_id'],
        where: {
          professional_id: { in: ids },
          status: 'COMPLETADO',
          scheduled_at: { gte: from, lte: now },
        },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ professional_id: string; n: number }[]>`
        select a.professional_id, count(*)::int as n
          from public.audit_logs l
          join public.appointments a on a.id = l.resource_id
         where l.resource_type = 'appointments'
           and l.action = any(${INCIDENT_ACTIONS}::text[])
           and l.created_at >= ${from}
           and a.professional_id = any(${ids}::uuid[])
         group by a.professional_id`,
      this.prisma.review.groupBy({
        by: ['professional_id'],
        where: { professional_id: { in: ids }, status: 'APROBADA' },
        _avg: { rating: true },
        _count: { _all: true },
      }),
    ]);

    for (const id of ids) {
      const done = completed.find((c) => c.professional_id === id);
      const inc = incidents.find((i) => i.professional_id === id);
      const rev = reviews.find((r) => r.professional_id === id);
      const avg = rev?._avg.rating;
      result.set(id, {
        completed: done?._count._all ?? 0,
        incidents: inc?.n ?? 0,
        rating: avg == null ? null : Math.round(avg * 10) / 10,
        reviews: rev?._count._all ?? 0,
      });
    }
    return result;
  }

  /** La decisión más reciente de cada profesional, de `audit_logs`. */
  private async lastDecisions(
    professionalIds: string[],
    status: 'VALIDADO' | 'RECHAZADO',
  ): Promise<Map<string, LicenseQueueItem['decision']>> {
    const decisions = new Map<string, LicenseQueueItem['decision']>();
    if (professionalIds.length === 0) return decisions;

    const logs = await this.prisma.auditLog.findMany({
      where: {
        resource_type: 'professionals',
        resource_id: { in: professionalIds },
        action: LICENSE_AUDIT_ACTIONS[status],
      },
      select: { resource_id: true, created_at: true, metadata: true },
      orderBy: { created_at: 'desc' },
    });
    for (const log of logs) {
      if (!log.resource_id || decisions.has(log.resource_id)) continue;
      const metadata = log.metadata as { reason?: unknown } | null;
      decisions.set(log.resource_id, {
        at: log.created_at.toISOString(),
        reason: typeof metadata?.reason === 'string' ? metadata.reason : null,
      });
    }
    return decisions;
  }
}
