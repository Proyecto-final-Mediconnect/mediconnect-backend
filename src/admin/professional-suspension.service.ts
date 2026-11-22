import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { resetAttendance } from '../appointments/attendance-reset';
import { PatientNoticesService } from '../notifications/patient-notices.service';
import { ProfessionalAccountNoticesService } from '../notifications/professional-account-notices.service';
import { AppointmentPaymentService } from '../payments/appointment-payment.service';
import { CancellationRefundService } from '../payments/cancellation-refund.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * El motivo que ve el paciente en el turno cancelado por la suspensión. El
 * motivo del administrador es para el profesional y la auditoría, no para los
 * pacientes.
 */
export const SUSPENSION_APPOINTMENT_REASON =
  'El profesional dejó de atender por MediConnect.';

/** Cuántos turnos resuelve la suspensión: los pagados se reembolsan, los impagos se cancelan. */
export interface SuspensionImpact {
  /** Pagados (confirmados futuros y a reprogramar): reembolso del 100 %. */
  paid: number;
  /** Reservas sin pagar futuras: se cancelan, no hay plata en juego. */
  unpaid: number;
}

export interface SuspensionResult {
  id: string;
  status: 'SUSPENDIDO';
  refunded: number;
  cancelled: number;
}

/**
 * Suspender y reactivar a un profesional (ENG-241, ENG-220).
 *
 * Suspender lo saca del catálogo (que solo lista `VALIDADO`) y bloquea las
 * reservas nuevas. Sus turnos pendientes no pueden quedar colgados, y como el
 * médico suspendido no puede atender, no se ofrece elegir otro horario: se
 * aplica ADR-018 ("si el turno no se da por causa del profesional, el paciente
 * no pierde lo que pagó"):
 *
 * - `CONFIRMADO` futuro y `A_REPROGRAMAR` → `CANCELADO` con **reembolso del
 *   100 %** y aviso.
 * - `RESERVADO_SIN_PAGAR` futuro → `CANCELADO`, con aviso y el link de pago
 *   vencido.
 *
 * Todo lo de la base va en una transacción (el estado del profesional, los
 * turnos y la auditoría): o se suspende con todo resuelto, o no pasa nada. Lo
 * de afuera (MercadoPago, avisos) va después del commit y nunca la deshace. Si
 * el proceso se cae antes de pedir un reembolso, el barrido de
 * `resolve-reprogram-deadlines` lo retoma: busca turnos cancelados por el
 * profesional con el pago aprobado y sin reembolso.
 *
 * Una consulta que ya empezó no se toca: se termina.
 */
@Injectable()
export class ProfessionalSuspensionService {
  private readonly logger = new Logger(ProfessionalSuspensionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: CancellationRefundService,
    private readonly payments: AppointmentPaymentService,
    private readonly patientNotices: PatientNoticesService,
    private readonly accountNotices: ProfessionalAccountNoticesService,
  ) {}

  /** Lo que resolvería suspenderlo ahora, para mostrarlo antes de confirmar. */
  async preview(
    professionalId: string,
    now: Date = new Date(),
  ): Promise<SuspensionImpact> {
    await this.findOrThrow(professionalId);
    const [paid, unpaid] = await Promise.all([
      this.prisma.appointment.count({
        where: {
          professional_id: professionalId,
          OR: [
            { status: 'CONFIRMADO', scheduled_at: { gt: now } },
            { status: 'A_REPROGRAMAR' },
          ],
        },
      }),
      this.prisma.appointment.count({
        where: {
          professional_id: professionalId,
          status: 'RESERVADO_SIN_PAGAR',
          scheduled_at: { gt: now },
        },
      }),
    ]);
    return { paid, unpaid };
  }

  async suspend(
    adminId: string,
    professionalId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<SuspensionResult> {
    const resolved = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.professional.updateMany({
        where: { profile_id: professionalId, status: 'VALIDADO' },
        data: { status: 'SUSPENDIDO', updated_at: now },
      });
      if (count === 0) await this.notApplicable(professionalId, 'VALIDADO');

      // Decide y escribe en un solo UPDATE … RETURNING, con el estado previo
      // leído en el mismo statement: un findMany y después un update dejaría
      // una ventana para que el webhook confirme un pago en el medio.
      const rows = await tx.$queryRaw<{ id: string; previous: string }[]>`
        with target as (
          select id, status
            from public.appointments
           where professional_id = ${professionalId}::uuid
             and (
               (status in ('CONFIRMADO', 'RESERVADO_SIN_PAGAR')
                  and scheduled_at > ${now})
               or status = 'A_REPROGRAMAR'
             )
           for update
        )
        update public.appointments a
           set status = 'CANCELADO'::appointment_status,
               cancelled_by = 'PROFESIONAL'::appointment_cancelled_by,
               cancellation_reason = case
                 when t.status = 'A_REPROGRAMAR' then a.cancellation_reason
                 else ${SUSPENSION_APPOINTMENT_REASON}
               end,
               cancelled_at = case
                 when t.status = 'A_REPROGRAMAR' then a.cancelled_at
                 else ${now}
               end,
               reprogram_deadline = null,
               updated_at = ${now}
          from target t
         where a.id = t.id
        returning a.id, t.status::text as previous`;

      const ids = rows.map((r) => r.id);
      await resetAttendance(tx, ids);

      const paid = rows.filter((r) => r.previous !== 'RESERVADO_SIN_PAGAR');
      const unpaid = rows.filter((r) => r.previous === 'RESERVADO_SIN_PAGAR');

      if (rows.length > 0) {
        await tx.auditLog.createMany({
          data: rows.map((r) => ({
            actor_id: adminId,
            action: 'APPOINTMENT_CANCELLED_BY_SUSPENSION',
            resource_type: 'appointments',
            resource_id: r.id,
            metadata: {
              previousStatus: r.previous,
              origin: 'ADMINISTRADOR',
              professionalId,
            },
          })),
        });
      }
      await tx.auditLog.create({
        data: {
          actor_id: adminId,
          action: 'PROFESSIONAL_SUSPENDED',
          resource_type: 'professionals',
          resource_id: professionalId,
          metadata: {
            origin: 'ADMINISTRADOR',
            reason,
            refunded: paid.length,
            cancelled: unpaid.length,
          },
        },
      });
      return { paid: paid.map((r) => r.id), unpaid: unpaid.map((r) => r.id) };
    });

    for (const id of resolved.paid) {
      // `refundInFull` nunca tira: si MercadoPago falla queda pendiente y lo
      // retoma el job de reintentos (ENG-205).
      const refund = await this.refunds.refundInFull(
        id,
        now,
        'CANCELACION_PROFESIONAL',
      );
      await this.patientNotices.fullRefund(
        id,
        { amount: refund.amount, status: refund.status, cause: 'SUSPENDIDO' },
        now,
      );
    }
    for (const id of resolved.unpaid) {
      // Si no, la pestaña de MercadoPago abierta cobraría un turno cancelado.
      await this.payments.expireCheckout(id, now);
      await this.patientNotices.professionalCancelled(id, 'CANCELADO', now);
    }
    await this.accountNotices.suspended(
      professionalId,
      reason,
      { refunded: resolved.paid.length, cancelled: resolved.unpaid.length },
      now,
    );

    this.logger.log(
      `Profesional ${professionalId} suspendido: ${resolved.paid.length} turno(s) reembolsado(s), ${resolved.unpaid.length} cancelado(s).`,
    );
    return {
      id: professionalId,
      status: 'SUSPENDIDO',
      refunded: resolved.paid.length,
      cancelled: resolved.unpaid.length,
    };
  }

  /**
   * Vuelve a `VALIDADO`: aparece en el catálogo otra vez. Los turnos que se
   * resolvieron al suspenderlo no vuelven, porque ya se reembolsaron.
   */
  async reactivate(
    adminId: string,
    professionalId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<{ id: string; status: 'VALIDADO' }> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.professional.updateMany({
        where: { profile_id: professionalId, status: 'SUSPENDIDO' },
        data: { status: 'VALIDADO', updated_at: now },
      });
      if (count === 0) await this.notApplicable(professionalId, 'SUSPENDIDO');
      await tx.auditLog.create({
        data: {
          actor_id: adminId,
          action: 'PROFESSIONAL_REACTIVATED',
          resource_type: 'professionals',
          resource_id: professionalId,
          metadata: { origin: 'ADMINISTRADOR', reason },
        },
      });
    });
    await this.accountNotices.reactivated(professionalId, now);
    return { id: professionalId, status: 'VALIDADO' };
  }

  private async findOrThrow(professionalId: string) {
    const professional = await this.prisma.professional.findUnique({
      where: { profile_id: professionalId },
      select: { status: true },
    });
    if (!professional) {
      throw new NotFoundException('No encontramos ese profesional.');
    }
    return professional;
  }

  /** 404 si no existe; 409 si no está en el estado que la acción necesita. */
  private async notApplicable(
    professionalId: string,
    expected: 'VALIDADO' | 'SUSPENDIDO',
  ): Promise<never> {
    const { status } = await this.findOrThrow(professionalId);
    if (expected === 'SUSPENDIDO') {
      throw new ConflictException('Ese profesional no está suspendido.');
    }
    throw new ConflictException(
      status === 'SUSPENDIDO'
        ? 'Ese profesional ya está suspendido.'
        : 'Solo se puede suspender a un profesional con la matrícula validada.',
    );
  }
}
