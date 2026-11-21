import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { appointment_status } from '../../generated/prisma';
import { PatientNoticesService } from '../notifications/patient-notices.service';
import { AppointmentPaymentService } from '../payments/appointment-payment.service';
import {
  type CancellationRefund,
  CancellationRefundService,
  type FullRefundReason,
} from '../payments/cancellation-refund.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';

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
export interface ReprogramSweepSummary {
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

    let next: ProfessionalCancellationResult['status'];
    if (row.status === 'CONFIRMADO') next = 'A_REPROGRAMAR';
    else if (row.status === 'RESERVADO_SIN_PAGAR') next = 'CANCELADO';
    else throw new ConflictException('Ese turno ya no está activo.');

    const deadline =
      next === 'A_REPROGRAMAR' ? reprogramDeadlineFor(scheduledAt, now) : null;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.appointment.update({
          // El `where` revalida todo lo que se chequeó arriba: si entre la
          // lectura y la escritura el webhook confirmó el pago, el job liberó la
          // reserva o un segundo click ya canceló, no matchea y sale 409.
          where: {
            id: row.id,
            professional_id: userId,
            status: row.status as appointment_status,
            scheduled_at: { gt: now },
          },
          data: {
            status: next,
            cancelled_by: 'PROFESIONAL',
            cancellation_reason: reason,
            cancelled_at: now,
            reprogram_deadline: deadline,
            updated_at: now,
          },
        });
        await tx.auditLog.create({
          data: {
            actor_id: userId,
            action: 'APPOINTMENT_CANCELLED_BY_PROFESSIONAL',
            resource_type: 'appointments',
            resource_id: row.id,
            metadata: {
              previousStatus: row.status,
              newStatus: next,
              reason,
              reprogramDeadline: deadline?.toISOString() ?? null,
            },
          },
        });
      });
    } catch (err) {
      throw this.writeError(err, 'cancelar el turno', row.id);
    }

    // Después del commit y sin tirar, como en la cancelación del paciente.
    if (next === 'CANCELADO') {
      // Si no, la pestaña de MercadoPago que el paciente dejó abierta cobraría
      // un turno cancelado. Si igual entra un pago, el webhook lo ve inactivo y
      // lo devuelve entero (ENG-144).
      await this.payments.expireCheckout(row.id, now);
    }
    await this.notices.professionalCancelled(row.id, next, now);

    return {
      id: row.id,
      status: next,
      cancelledBy: 'PROFESIONAL',
      reprogramDeadline: deadline?.toISOString() ?? null,
    };
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
    return { expired: expired.length, recovered: stranded.length };
  }

  private async refundAndNotify(
    appointmentId: string,
    now: Date,
    reason: FullRefundReason,
  ): Promise<void> {
    const refund = await this.refunds.refundInFull(appointmentId, now, reason);
    await this.notices.fullRefund(
      appointmentId,
      {
        amount: refund.amount,
        status: refund.status,
        cause: reason === 'VENCIMIENTO_REPROGRAMACION' ? 'VENCIDO' : 'ELEGIDO',
      },
      now,
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
