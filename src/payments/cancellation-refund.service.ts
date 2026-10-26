import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  refundPercentFor,
  resolvePolicy,
} from '../professionals/cancellation-policy';
import { MercadoPagoService } from './mercadopago.service';

/** Estado del reembolso de una cancelación, tal como lo ve el paciente. */
export type RefundOutcome =
  /** MercadoPago lo aprobó: la plata vuelve al medio de pago. */
  | 'PROCESADO'
  /** Quedó registrado pero MercadoPago no lo confirmó (todavía). */
  | 'PENDIENTE'
  /** MercadoPago lo rechazó: hay que resolverlo a mano. */
  | 'RECHAZADO';

/** Cuánto le corresponde al paciente si cancela, y qué pasó con eso. */
export interface CancellationRefund {
  /** Porcentaje de la política congelada en el turno, 0 a 100. */
  percent: number;
  /** Monto a devolver, en la moneda del pago. 0 si no corresponde nada. */
  amount: number;
  /** `null` si no hubo nada que devolver: el turno no estaba pago o la
   *  política da 0 %. */
  status: RefundOutcome | null;
}

/** Fila del turno que hace falta para calcular el reembolso. */
interface RefundableAppointment {
  id: string;
  scheduled_at: Date;
  policy_hours_full_refund: number | null;
  policy_hours_partial_refund: number | null;
  policy_partial_refund_percent: number | null;
  payment: {
    id: string;
    amount: Prisma.Decimal;
    status: string;
    mercadopago_payment_id: string | null;
  } | null;
}

const REFUNDABLE_SELECT = {
  id: true,
  scheduled_at: true,
  policy_hours_full_refund: true,
  policy_hours_partial_refund: true,
  policy_partial_refund_percent: true,
  payment: {
    select: {
      id: true,
      amount: true,
      status: true,
      mercadopago_payment_id: true,
    },
  },
} as const;

/** Motivo que queda en `refunds.reason`. */
const CANCELLATION_REASON = 'CANCELACION_PACIENTE';

/**
 * Por qué se devuelve un pago que no se pudo aplicar a un turno (ENG-144). Va en
 * `refunds.reason` junto con el id del pago de MercadoPago, que es lo que hace
 * idempotente el reembolso cuando el webhook se repite.
 */
export type UnappliedPaymentReason =
  /** Un segundo pago aprobado sobre un turno que ya estaba pagado. */
  | 'PAGO_DUPLICADO'
  /** El pago se aprobó cuando el turno ya estaba cancelado o liberado. */
  | 'PAGO_SOBRE_TURNO_INACTIVO';

/**
 * Reembolso al cancelar un turno pagado (ENG-65).
 *
 * El porcentaje sale de la política **congelada en el turno** al reservar (la
 * copia un trigger, ver la migración de ENG-65), no de la vigente: si el
 * profesional la cambió después, el paciente recibe lo que vio cuando pagó. El
 * monto se calcula sobre `payments.amount`, que es lo que efectivamente se
 * cobró.
 *
 * ## Si MercadoPago falla
 *
 * La cancelación no se deshace. El turno ya está cancelado y el horario libre;
 * revertir eso porque el proveedor no contestó sería peor. El reembolso queda
 * `PENDIENTE` en `refunds`, con el error en el log, para resolverlo a mano. La
 * fila se crea **antes** de llamar a MercadoPago justamente para que un fallo
 * no deje un reembolso sin rastro.
 */
@Injectable()
export class CancellationRefundService {
  private readonly logger = new Logger(CancellationRefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mercadoPago: MercadoPagoService,
  ) {}

  /**
   * Lo que le correspondería al paciente si cancela en `now`, sin devolver
   * nada. Es lo que muestra la pantalla antes de confirmar.
   */
  async quote(appointmentId: string, now: Date): Promise<CancellationRefund> {
    const appointment = await this.read(appointmentId);
    const { percent, amount } = this.compute(appointment, now);
    return { percent, amount: amount.toNumber(), status: null };
  }

  /**
   * Devuelve lo que corresponda de un turno que se acaba de cancelar.
   *
   * Lo llama `AppointmentsService.cancel` después de pasar el turno a
   * `CANCELADO`, y ese UPDATE es condicional sobre el estado anterior: solo una
   * cancelación gana, así que este método corre una sola vez por turno.
   *
   * **Nunca tira**, igual que `expireCheckout`: la cancelación ya se escribió y
   * un error acá no puede convertirla en un 500.
   */
  async refundCancellation(
    appointmentId: string,
    now: Date,
  ): Promise<CancellationRefund> {
    try {
      return await this.refund(appointmentId, now);
    } catch (err) {
      this.logger.error(
        `No se pudo registrar el reembolso del turno ${appointmentId}: ${String(err)}`,
      );
      return { percent: 0, amount: 0, status: 'PENDIENTE' };
    }
  }

  /**
   * Devuelve **entero** un pago aprobado que no se pudo aplicar a ningún turno
   * (ENG-144): un segundo pago sobre un turno ya pagado, o un pago que llegó
   * cuando el turno ya estaba cancelado o liberado. No hay política que aplicar:
   * no se prestó ningún servicio a cambio.
   *
   * - **Idempotente:** el webhook se repite. Si ya hay un reembolso registrado
   *   para ese pago de MercadoPago, no se pide otro; y la clave de idempotencia
   *   de MercadoPago es el id del pago, así que tampoco duplica si la fila se
   *   llegó a crear pero la respuesta se perdió.
   * - Con `markPaymentRefunded`, un reembolso procesado deja la fila de
   *   `payments` en `REEMBOLSADO`. Para el duplicado no: esa fila es del primer
   *   pago, que sigue valiendo.
   * - Si no se puede, queda en Sentry con el id del pago para devolverlo a mano.
   *
   * **Nunca tira:** lo llama el webhook, que no puede contestarle un 5xx a
   * MercadoPago por esto.
   */
  async refundUnappliedPayment(
    params: {
      paymentId: string;
      mpPaymentId: string;
      amount: number;
      reason: UnappliedPaymentReason;
      markPaymentRefunded: boolean;
    },
    now: Date,
  ): Promise<RefundOutcome> {
    const { paymentId, mpPaymentId, reason, markPaymentRefunded } = params;
    const reasonText = `${reason}:${mpPaymentId}`;

    try {
      const existing = await this.prisma.refund.findFirst({
        where: { payment_id: paymentId, reason: reasonText },
        select: { status: true },
      });
      if (existing) return existing.status;

      const amount = new Prisma.Decimal(params.amount);
      const refund = await this.prisma.refund.create({
        data: { payment_id: paymentId, amount, reason: reasonText },
      });

      let status: RefundOutcome = 'PENDIENTE';
      try {
        const mp = await this.mercadoPago.refundPayment(
          mpPaymentId,
          amount.toNumber(),
          `unapplied-${mpPaymentId}`,
        );
        status =
          mp.status === 'approved'
            ? 'PROCESADO'
            : mp.status === 'rejected' || mp.status === 'cancelled'
              ? 'RECHAZADO'
              : 'PENDIENTE';

        await this.prisma.refund.update({
          where: { id: refund.id },
          data: {
            status,
            mercadopago_refund_id: mp.id,
            processed_at: status === 'PENDIENTE' ? null : now,
          },
        });

        if (status === 'PROCESADO' && markPaymentRefunded) {
          await this.prisma.payment.update({
            where: { id: paymentId },
            data: { status: 'REEMBOLSADO' },
          });
        }
      } catch (err) {
        this.logger.error(
          `No se pudo devolver el pago ${mpPaymentId} (${reason}, refund ${refund.id}): ${String(err)}`,
        );
      }

      if (status !== 'PROCESADO') {
        this.alertManualRefund(mpPaymentId, reason, status);
      }
      return status;
    } catch (err) {
      this.logger.error(
        `No se pudo registrar la devolución del pago ${mpPaymentId} (${reason}): ${String(err)}`,
      );
      this.alertManualRefund(mpPaymentId, reason, 'PENDIENTE');
      return 'PENDIENTE';
    }
  }

  private alertManualRefund(
    mpPaymentId: string,
    reason: UnappliedPaymentReason,
    status: RefundOutcome,
  ): void {
    this.logger.warn(
      `Pago ${mpPaymentId} (${reason}) sin devolver: quedó ${status}. Devolverlo a mano desde MercadoPago.`,
    );
    Sentry.captureMessage(
      `Pago de MercadoPago sin devolver (${reason}): hay que devolverlo a mano`,
      {
        level: 'error',
        tags: { area: 'pagos', reason },
        extra: { mpPaymentId, status },
      },
    );
  }

  private async refund(
    appointmentId: string,
    now: Date,
  ): Promise<CancellationRefund> {
    const appointment = await this.read(appointmentId);
    const { percent, amount } = this.compute(appointment, now);
    const payment = appointment?.payment;

    if (!payment?.mercadopago_payment_id || amount.isZero()) {
      return { percent, amount: amount.toNumber(), status: null };
    }

    const refund = await this.prisma.refund.create({
      data: {
        payment_id: payment.id,
        amount,
        reason: CANCELLATION_REASON,
      },
    });

    let status: RefundOutcome = 'PENDIENTE';
    try {
      // La clave es el id de la fila: reintentar el mismo reembolso no puede
      // devolver dos veces, y un reembolso distinto tiene otra fila.
      const mp = await this.mercadoPago.refundPayment(
        payment.mercadopago_payment_id,
        amount.toNumber(),
        `refund-${refund.id}`,
      );
      status =
        mp.status === 'approved'
          ? 'PROCESADO'
          : mp.status === 'rejected' || mp.status === 'cancelled'
            ? 'RECHAZADO'
            : 'PENDIENTE';

      await this.prisma.refund.update({
        where: { id: refund.id },
        data: {
          status,
          mercadopago_refund_id: mp.id,
          processed_at: status === 'PENDIENTE' ? null : now,
        },
      });

      // Solo con el total: un reembolso parcial deja el pago `approved` en
      // MercadoPago, y acá también.
      if (status === 'PROCESADO' && amount.equals(payment.amount)) {
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'REEMBOLSADO' },
        });
      }
    } catch (err) {
      this.logger.error(
        `No se pudo reembolsar el turno ${appointmentId} (refund ${refund.id}): ${String(err)}`,
      );
    }

    if (status !== 'PROCESADO') {
      this.logger.warn(
        `Reembolso ${refund.id} del turno ${appointmentId} quedó ${status}: revisarlo a mano.`,
      );
    }

    return { percent, amount: amount.toNumber(), status };
  }

  private async read(
    appointmentId: string,
  ): Promise<RefundableAppointment | null> {
    return this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: REFUNDABLE_SELECT,
    });
  }

  /** Porcentaje y monto. Sin pago aprobado no hay nada que devolver. */
  private compute(
    appointment: RefundableAppointment | null,
    now: Date,
  ): { percent: number; amount: Prisma.Decimal } {
    if (!appointment) {
      return { percent: 0, amount: new Prisma.Decimal(0) };
    }

    const { policy } = resolvePolicy({
      hours_full_refund: appointment.policy_hours_full_refund,
      hours_partial_refund: appointment.policy_hours_partial_refund,
      partial_refund_percent: appointment.policy_partial_refund_percent,
    });
    const percent = refundPercentFor(policy, appointment.scheduled_at, now);

    const payment = appointment.payment;
    if (payment?.status !== 'APROBADO') {
      return { percent, amount: new Prisma.Decimal(0) };
    }

    return {
      percent,
      amount: payment.amount.mul(percent).div(100).toDecimalPlaces(2),
    };
  }
}
