import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { appointment_status } from '../../generated/prisma';
import type { Prisma } from '../../generated/prisma/client';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { PatientNoticesService } from '../notifications/patient-notices.service';
import { AppointmentPaymentService } from '../payments/appointment-payment.service';
import {
  type CancellationRefund,
  CancellationRefundService,
  type FullRefundReason,
} from '../payments/cancellation-refund.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { resetAttendance } from './attendance-reset';

/**
 * Cuánto tiene el paciente para elegir después de que el profesional cancela
 * (ADR-018, caso 2), salvo que el turno sea antes.
 */
export const REPROGRAM_WINDOW_HOURS = 48;

/**
 * Cuánto se espera antes de que el job retome un reembolso total que no llegó a
 * registrarse (ver `resolveReprogramDeadlines`). Da tiempo a que termine el
 * request que lo está haciendo en ese momento.
 */
export const REFUND_SWEEP_GRACE_MINUTES = 10;

/** `P2025` de Prisma: el `where` del update no encontró la fila. */
const PRISMA_RECORD_NOT_FOUND = 'P2025';

/**
 * Plazo para elegir: la hora original del turno o 48 h desde el aviso, lo que
 * llegue primero (ADR-018, caso 2). Más allá de la hora del turno no tiene
 * sentido esperar: ese horario ya pasó.
 */
export function reprogramDeadlineFor(scheduledAt: Date, now: Date): Date {
  const window = new Date(now.getTime() + REPROGRAM_WINDOW_HOURS * 3_600_000);
  return scheduledAt < window ? scheduledAt : window;
}

/**
 * Plazo para elegir de un turno que ya pasó y no se realizó (ENG-237, casos 3,
 * 4 y 13): 48 h desde el aviso. La hora original ya pasó, así que no acota.
 */
export function reprogramDeadlineAfterMissed(now: Date): Date {
  return new Date(now.getTime() + REPROGRAM_WINDOW_HOURS * 3_600_000);
}

/** Resultado de la cancelación del profesional. */
export interface ProfessionalCancellationResult {
  id: string;
  /** `A_REPROGRAMAR` si estaba pagado; `CANCELADO` si era una reserva sin pagar. */
  status: 'A_REPROGRAMAR' | 'CANCELADO';
  cancelledBy: 'PROFESIONAL';
  /** ISO-8601; `null` si quedó cancelado. */
  reprogramDeadline: string | null;
}

/** Resultado de pedir el reembolso desde `A_REPROGRAMAR`. */
export interface FullRefundResult {
  id: string;
  status: 'CANCELADO';
  refund: CancellationRefund;
}

/** Lo que hizo una corrida del job de vencimientos. */
/**
 * Cuántas horas antes de que venza el plazo para elegir se le recuerda al
 * paciente (ENG-208, caso 2). Si al cancelar ya quedaba menos, el aviso de la
 * cancelación hace de recordatorio.
 */
export const REPROGRAM_REMINDER_HOURS = 12;

export interface ReprogramSweepSummary {
  /** Pacientes a los que se les recordó que se vence el plazo (ENG-208). */
  reminded: number;
  /** Turnos cuyo plazo venció y se reembolsaron al 100 %. */
  expired: number;
  /** Reembolsos totales que habían quedado sin registrar y se retomaron. */
  recovered: number;
}

/** Fila del turno que se lee con el JWT del usuario. */
interface CancellableRow {
  id: string;
  patient_id: string;
  professional_id: string;
  scheduled_at: string;
  status: string;
}

const ROW_SELECT = 'id, patient_id, professional_id, scheduled_at, status';

/**
 * El profesional cancela un turno y lo que pasa después (ENG-204, ADR-018,
 * casos 1, 2, 10, 11 y 12).
 *
 * ## Máquina de estados
 *
 * - `CONFIRMADO` → **`A_REPROGRAMAR`**: el profesional cancela un turno pagado.
 *   El horario queda libre (el índice parcial de horarios ocupados solo cuenta
 *   `RESERVADO_SIN_PAGAR` y `CONFIRMADO`) y el paciente tiene hasta
 *   `reprogram_deadline` para elegir otro horario (ENG-203) o el reembolso.
 * - `RESERVADO_SIN_PAGAR` → **`CANCELADO`**: una reserva sin pagar no tiene
 *   plata en juego; se cancela con aviso.
 * - `A_REPROGRAMAR` → **`CANCELADO`** con reembolso del 100 %: lo pide el
 *   paciente (`requestFullRefund`) o vence el plazo (`resolveReprogramDeadlines`,
 *   con `cancelled_by = SISTEMA`).
 *
 * ## Carreras
 *
 * Cada transición es un UPDATE condicional sobre el estado anterior, como la
 * cancelación del paciente (ENG-55): si dos caminos compiten (el paciente pide
 * el reembolso justo cuando vence el plazo, el webhook confirma el pago
 * mientras el profesional cancela la reserva) gana uno solo y el otro recibe
 * 409 o no encuentra nada. Por eso el reembolso total corre una sola vez.
 *
 * ## Lectura y escritura
 *
 * Igual que `AppointmentsService.cancel`: se **lee** con el JWT del usuario
 * (RLS decide si participa del turno; si no, 404) y se **escribe** por Prisma,
 * porque `authenticated` no tiene UPDATE sobre `appointments`.
 */
@Injectable()
export class ProfessionalCancellationService {
  private readonly logger = new Logger(ProfessionalCancellationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly payments: AppointmentPaymentService,
    private readonly refunds: CancellationRefundService,
    private readonly notices: PatientNoticesService,
    private readonly inApp: InAppNotificationsService,
  ) {}

  /**
   * El profesional cancela un turno futuro propio, con un motivo.
   *
   * Solo turnos que todavía no empezaron: la ausencia del profesional o una
   * consulta que falló es otro camino (ENG-237).
   */
  async cancelByProfessional(
    accessToken: string,
    userId: string,
    appointmentId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<ProfessionalCancellationResult> {
    const row = await this.read(accessToken, appointmentId);
    if (row.professional_id !== userId) {
      throw new ForbiddenException(
        'Solo el profesional del turno puede cancelarlo desde acá.',
      );
    }
    const scheduledAt = new Date(row.scheduled_at);
    if (scheduledAt <= now) {
      throw new ConflictException(
        'Ese turno ya empezó o ya pasó: no se puede cancelar.',
      );
    }

    let result: ProfessionalCancellationResult;
    try {
      result = await this.prisma.$transaction((tx) =>
        this.applyCancellation(
          tx,
          { ...row, scheduled_at: scheduledAt },
          reason,
          userId,
          now,
          'MANUAL',
        ),
      );
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      throw this.writeError(err, 'cancelar el turno', row.id);
    }

    await this.afterCancellation(result, now);
    return result;
  }

  /**
   * Escribe, dentro de la transacción `tx`, que el profesional cancela un turno
   * (ADR-018, casos 1 y 11): `CONFIRMADO` → `A_REPROGRAMAR` con plazo, y
   * `RESERVADO_SIN_PAGAR` → `CANCELADO`. Deja la auditoría. **No** hace nada
   * fuera de la base: los avisos y el link de pago van en `afterCancellation`,
   * después del commit.
   *
   * La usan la cancelación de un turno (`cancelByProfessional`) y el bloqueo de
   * agenda que pisa turnos (ENG-206), que cancela varios en una sola
   * transacción con el bloqueo: o se guarda todo, o nada.
   *
   * El `where` revalida estado, profesional y que el turno no haya empezado: si
   * algo cambió entre la lectura y la escritura (el webhook confirmó el pago,
   * el job liberó la reserva, un segundo click ya canceló), Prisma tira P2025.
   */
  async applyCancellation(
    tx: Prisma.TransactionClient,
    row: {
      id: string;
      professional_id: string;
      status: string;
      scheduled_at: Date;
    },
    reason: string,
    actorId: string,
    now: Date,
    origin: 'MANUAL' | 'BLOQUEO',
  ): Promise<ProfessionalCancellationResult> {
    if (row.scheduled_at <= now) {
      throw new ConflictException(
        'Ese turno ya empezó o ya pasó: no se puede cancelar.',
      );
    }
    let next: ProfessionalCancellationResult['status'];
    let previous: appointment_status;
    if (row.status === 'CONFIRMADO') {
      previous = 'CONFIRMADO';
      next = 'A_REPROGRAMAR';
    } else if (row.status === 'RESERVADO_SIN_PAGAR') {
      previous = 'RESERVADO_SIN_PAGAR';
      next = 'CANCELADO';
    } else {
      throw new ConflictException('Ese turno ya no está activo.');
    }

    const deadline =
      next === 'A_REPROGRAMAR'
        ? reprogramDeadlineFor(row.scheduled_at, now)
        : null;

    await tx.appointment.update({
      where: {
        id: row.id,
        professional_id: actorId,
        status: previous,
        scheduled_at: { gt: now },
      },
      data: {
        status: next,
        cancelled_by: 'PROFESIONAL',
        cancellation_reason: reason,
        cancelled_at: now,
        reprogram_deadline: deadline,
        // ENG-237: es una cancelación a mano, aunque antes hubiera sido una
        // ausencia o una falla (caso 12).
        reprogram_cause: null,
        updated_at: now,
      },
    });
    // ENG-237: la sala abre unos minutos antes del turno; si alguien ya había
    // entrado, el horario nuevo arranca sin esas marcas.
    if (next === 'A_REPROGRAMAR') await resetAttendance(tx, [row.id]);
    await tx.auditLog.create({
      data: {
        actor_id: actorId,
        action: 'APPOINTMENT_CANCELLED_BY_PROFESSIONAL',
        resource_type: 'appointments',
        resource_id: row.id,
        metadata: {
          previousStatus: row.status,
          newStatus: next,
          reason,
          reprogramDeadline: deadline?.toISOString() ?? null,
          origin,
        },
      },
    });

    return {
      id: row.id,
      status: next,
      cancelledBy: 'PROFESIONAL',
      reprogramDeadline: deadline?.toISOString() ?? null,
    };
  }

  /**
   * Lo que va después del commit de `applyCancellation`. **Nunca tira**: la
   * cancelación ya quedó escrita.
   */
  async afterCancellation(
    result: ProfessionalCancellationResult,
    now: Date,
  ): Promise<void> {
    if (result.status === 'CANCELADO') {
      // Si no, la pestaña de MercadoPago que el paciente dejó abierta cobraría
      // un turno cancelado. Si igual entra un pago, el webhook lo ve inactivo y
      // lo devuelve entero (ENG-144).
      await this.payments.expireCheckout(result.id, now);
    }
    await this.notices.professionalCancelled(result.id, result.status, now);
  }

  /**
   * El paciente elige el reembolso del 100 % de un turno que el profesional
   * canceló (ADR-018, caso 1). El turno queda `CANCELADO`; `cancelled_by`
   * sigue siendo `PROFESIONAL`, porque fue quien lo canceló.
   *
   * Se puede aunque el plazo haya vencido y el job todavía no haya pasado: el
   * resultado es el mismo, y quien llegue primero lo resuelve.
   */
  async requestFullRefund(
    accessToken: string,
    userId: string,
    appointmentId: string,
    now: Date = new Date(),
  ): Promise<FullRefundResult> {
    const row = await this.read(accessToken, appointmentId);
    if (row.patient_id !== userId) {
      throw new ForbiddenException(
        'Solo el paciente del turno puede pedir el reembolso.',
      );
    }
    if (row.status !== 'A_REPROGRAMAR') {
      throw new ConflictException(
        row.status === 'CANCELADO'
          ? 'Ese turno ya se resolvió.'
          : 'Ese turno no está esperando que elijas.',
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.appointment.update({
          where: {
            id: row.id,
            patient_id: userId,
            status: 'A_REPROGRAMAR',
          },
          data: { status: 'CANCELADO', updated_at: now },
        });
        await tx.auditLog.create({
          data: {
            actor_id: userId,
            action: 'APPOINTMENT_FULL_REFUND_CHOSEN',
            resource_type: 'appointments',
            resource_id: row.id,
            metadata: { previousStatus: 'A_REPROGRAMAR', origin: 'PACIENTE' },
          },
        });
      });
    } catch (err) {
      throw this.writeError(err, 'pedir el reembolso', row.id);
    }

    const refund = await this.refunds.refundInFull(
      row.id,
      now,
      'CANCELACION_PROFESIONAL',
    );
    await this.notices.fullRefund(
      row.id,
      { amount: refund.amount, status: refund.status, cause: 'ELEGIDO' },
      now,
    );
    // ENG-208: el profesional se entera de cómo terminó el turno que canceló.
    await this.inApp.notifyProfessional(row.id, 'TURNO_REEMBOLSADO', now, {
      cause: 'ELEGIDO',
    });
    return { id: row.id, status: 'CANCELADO', refund };
  }

  /**
   * Job (ADR-018, caso 2). Dos pasos, los dos idempotentes:
   *
   * 1. **Vencimientos:** los turnos `A_REPROGRAMAR` cuyo plazo pasó quedan
   *    `CANCELADO` (`cancelled_by = SISTEMA`) con reembolso del 100 %. Decide y
   *    escribe en un solo `UPDATE … RETURNING`, igual que el cierre de turnos
   *    (ENG-189): un `findMany` y después un `update` dejaría una ventana para
   *    que el paciente pida el reembolso del mismo turno.
   * 2. **Reembolsos que quedaron a medias:** si el proceso se cayó entre el
   *    cambio de estado y el reembolso (aquí o en `requestFullRefund`), queda un
   *    turno cancelado por el profesional o por vencimiento con el pago todavía
   *    aprobado y sin ningún reembolso. Se retoma, con un margen de
   *    `REFUND_SWEEP_GRACE_MINUTES` para no pisar un request en curso. El
   *    índice único de `refunds` para estos motivos frena igual un doble.
   */
  async resolveReprogramDeadlines(
    now: Date = new Date(),
  ): Promise<ReprogramSweepSummary> {
    const reminded = await this.remindDeadlines(now);

    const expired = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        update public.appointments
           set status = 'CANCELADO'::appointment_status,
               cancelled_by = 'SISTEMA'::appointment_cancelled_by,
               updated_at = ${now}
         where status = 'A_REPROGRAMAR'::appointment_status
           and reprogram_deadline <= ${now}
        returning id`;
      if (rows.length > 0) {
        await tx.auditLog.createMany({
          data: rows.map((r) => ({
            actor_id: null,
            action: 'APPOINTMENT_REPROGRAM_EXPIRED',
            resource_type: 'appointments',
            resource_id: r.id,
            metadata: { previousStatus: 'A_REPROGRAMAR', origin: 'JOB' },
          })),
        });
      }
      return rows.map((r) => r.id);
    });

    for (const id of expired) {
      await this.refundAndNotify(id, now, 'VENCIMIENTO_REPROGRAMACION');
    }

    const stranded = await this.prisma.appointment.findMany({
      where: {
        status: 'CANCELADO',
        cancelled_by: { in: ['PROFESIONAL', 'SISTEMA'] },
        updated_at: {
          lt: new Date(now.getTime() - REFUND_SWEEP_GRACE_MINUTES * 60_000),
        },
        payment: { status: 'APROBADO', refunds: { none: {} } },
      },
      select: { id: true, cancelled_by: true },
      take: 50,
    });
    for (const a of stranded) {
      this.logger.warn(
        `Reembolso total sin registrar en el turno ${a.id}: se retoma.`,
      );
      await this.refundAndNotify(
        a.id,
        now,
        a.cancelled_by === 'SISTEMA'
          ? 'VENCIMIENTO_REPROGRAMACION'
          : 'CANCELACION_PROFESIONAL',
      );
    }

    if (expired.length > 0) {
      this.logger.log(
        `Vencieron ${expired.length} turno(s) a reprogramar: reembolsados al 100 %.`,
      );
    }
    return { reminded, expired: expired.length, recovered: stranded.length };
  }

  /**
   * ENG-208 (caso 2): a los turnos `A_REPROGRAMAR` a los que les quedan
   * `REPROGRAM_REMINDER_HOURS` o menos, se les recuerda el plazo. Una vez por
   * cancelación: un turno que el profesional vuelve a cancelar (caso 12) tiene
   * su propio recordatorio. Nunca tira: los vencimientos se resuelven igual.
   */
  private async remindDeadlines(now: Date): Promise<number> {
    const windowMs = REPROGRAM_REMINDER_HOURS * 3_600_000;
    try {
      const rows = await this.prisma.appointment.findMany({
        where: {
          status: 'A_REPROGRAMAR',
          reprogram_deadline: {
            gt: now,
            lte: new Date(now.getTime() + windowMs),
          },
        },
        select: {
          id: true,
          cancelled_at: true,
          reprogram_deadline: true,
          notifications: {
            where: {
              type: 'PLAZO_REPROGRAMACION_POR_VENCER',
              channel: 'IN_APP',
            },
            select: { sent_at: true },
          },
        },
        orderBy: { reprogram_deadline: 'asc' },
        take: 200,
      });

      let reminded = 0;
      for (const row of rows) {
        const cancelledAt = row.cancelled_at;
        const deadline = row.reprogram_deadline;
        if (!cancelledAt || !deadline) continue;
        // Si al cancelar ya quedaba poco, el aviso de la cancelación alcanza.
        if (deadline.getTime() - cancelledAt.getTime() <= windowMs) continue;
        const yaRecordado = row.notifications.some(
          (n) => n.sent_at !== null && n.sent_at >= cancelledAt,
        );
        if (yaRecordado) continue;
        await this.notices.reprogramDeadlineSoon(row.id, now);
        reminded += 1;
      }
      return reminded;
    } catch (err) {
      this.logger.error(
        `No se pudieron recordar los plazos para elegir: ${String(err)}`,
      );
      return 0;
    }
  }

  private async refundAndNotify(
    appointmentId: string,
    now: Date,
    reason: FullRefundReason,
  ): Promise<void> {
    const refund = await this.refunds.refundInFull(appointmentId, now, reason);
    const cause =
      reason === 'VENCIMIENTO_REPROGRAMACION' ? 'VENCIDO' : 'ELEGIDO';
    await this.notices.fullRefund(
      appointmentId,
      { amount: refund.amount, status: refund.status, cause },
      now,
    );
    // ENG-208: al profesional, una vez por turno (un turno reembolsado no
    // vuelve a cambiar); si el job lo retoma, el duplicado se ignora.
    await this.inApp.notifyProfessional(
      appointmentId,
      'TURNO_REEMBOLSADO',
      now,
      {
        cause,
      },
    );
  }

  /**
   * Lee el turno con el JWT del usuario. RLS es la autorización: el turno de
   * otras dos personas no aparece y da 404, sin confirmar que el id existe.
   */
  private async read(
    accessToken: string,
    appointmentId: string,
  ): Promise<CancellableRow> {
    const { data, error } = await this.supabase
      .getClientForToken(accessToken)
      .from('appointments')
      .select(ROW_SELECT)
      .eq('id', appointmentId)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        'No pudimos leer el turno. Probá de nuevo en unos minutos.',
      );
    }
    if (!data) throw new NotFoundException('Ese turno no existe.');
    return data as unknown as CancellableRow;
  }

  private writeError(err: unknown, what: string, id: string): Error {
    if ((err as { code?: string }).code === PRISMA_RECORD_NOT_FOUND) {
      return new ConflictException(
        'El turno cambió de estado mientras lo hacías. Actualizá la pantalla.',
      );
    }
    this.logger.error(`No se pudo ${what} (turno ${id}): ${String(err)}`);
    return new InternalServerErrorException(
      `No pudimos ${what}. Probá de nuevo en unos minutos.`,
    );
  }
}
