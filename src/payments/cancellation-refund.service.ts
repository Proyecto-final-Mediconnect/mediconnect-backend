import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Prisma } from '../../generated/prisma/client';
import { PatientNoticesService } from '../notifications/patient-notices.service';
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

/**
 * Cuánto se insiste con un reembolso que MercadoPago no confirmó (ENG-205,
 * ADR-018 caso 16). Pasado este plazo se marca RECHAZADO con motivo y se avisa
 * al equipo: nunca queda PENDIENTE en silencio.
 */
export const REFUND_RETRY_WINDOW_HOURS = 48;

/** Espera entre reintentos: 15 min, 30, 1 h, 2 h... hasta 6 h. */
const RETRY_BASE_MS = 15 * 60_000;
const RETRY_MAX_MS = 6 * 3_600_000;

/** Cuántos reembolsos toma una corrida del job. */
const RETRY_BATCH = 25;

/** Tope del error que se guarda: alcanza para soporte y no crece sin control. */
const MAX_ERROR_LENGTH = 500;

/** Lo que hizo una corrida del job de reintentos. */
export interface RefundRetrySummary {
  /** Reembolsos que se volvieron a intentar o a consultar. */
  revisados: number;
  procesados: number;
  /** Los que se dieron por perdidos: RECHAZADO con motivo, para soporte. */
  rechazados: number;
}

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
    /** La devolución entera que anotó el webhook (ENG-180), si la hay. */
    refunds: { amount: Prisma.Decimal; status: RefundOutcome }[];
  } | null;
}

/** `reason` del pago aprobado sobre un turno ya cancelado o liberado. */
const INACTIVE_APPOINTMENT_REASON: UnappliedPaymentReason =
  'PAGO_SOBRE_TURNO_INACTIVO';

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
      // Viaja en la misma consulta del turno: evita un viaje más por cancelación.
      refunds: {
        where: { reason: { startsWith: `${INACTIVE_APPOINTMENT_REASON}:` } },
        select: { amount: true, status: true },
        take: 1,
      },
    },
  },
} as const;

/** Violación de unicidad en Prisma. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** MercadoPago vence la `X-Idempotency-Key` a las 24 h. */
const IDEMPOTENCY_KEY_TTL_MS = 24 * 3_600_000;

/** Motivo que queda en `refunds.reason` cuando cancela el paciente. */
const CANCELLATION_REASON = 'CANCELACION_PACIENTE';

/**
 * Por qué se devuelve el 100 % de un turno pagado que no se dio por causa del
 * profesional (ADR-018). Va en `refunds.reason`; ninguno empieza con `PAGO_`,
 * así que no entra en el índice único de ENG-144.
 */
export type FullRefundReason =
  /** El profesional canceló y el paciente eligió el reembolso (caso 1). */
  | 'CANCELACION_PROFESIONAL'
  /** El profesional canceló y venció el plazo para elegir (caso 2). */
  | 'VENCIMIENTO_REPROGRAMACION';

const FULL_REFUND_REASONS: readonly FullRefundReason[] = [
  'CANCELACION_PROFESIONAL',
  'VENCIMIENTO_REPROGRAMACION',
];

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
    private readonly notices: PatientNoticesService,
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
      // Falló la lectura: sin ella no hay monto que informar.
      this.logger.error(
        `REFUND_LOST: no se pudo calcular el reembolso del turno ${appointmentId}: ${String(err)}`,
      );
      return { percent: 0, amount: 0, status: 'PENDIENTE' };
    }
  }

  /**
   * Devuelve el **100 %** del pago de un turno que no se dio por causa del
   * profesional (ADR-018, casos 1 y 2), sin mirar la política de cancelación:
   * las penalidades son solo para las decisiones del paciente.
   *
   * La llama `ProfessionalCancellationService` después de pasar el turno de
   * `A_REPROGRAMAR` a `CANCELADO`. Ese UPDATE es condicional sobre el estado,
   * así que gana una sola de las dos salidas posibles (el paciente pide el
   * reembolso o vence el plazo) y este método corre una vez por turno.
   *
   * **Nunca tira**, por lo mismo que `refundCancellation`.
   */
  async refundInFull(
    appointmentId: string,
    now: Date,
    reason: FullRefundReason,
  ): Promise<CancellationRefund> {
    try {
      return await this.refund(appointmentId, now, { percent: 100, reason });
    } catch (err) {
      this.logger.error(
        `REFUND_LOST: no se pudo calcular el reembolso total del turno ${appointmentId}: ${String(err)}`,
      );
      Sentry.captureException(err, {
        tags: { feature: 'eng204', operation: 'refund_in_full' },
      });
      return { percent: 100, amount: 0, status: 'PENDIENTE' };
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
   *   llegó a crear pero la respuesta se perdió. Una fila `PENDIENTE` o
   *   `RECHAZADO` se reintenta (dentro de las 24 h de la clave), y el índice
   *   único parcial `refunds_payment_reason_uq` evita dos filas por entregas
   *   concurrentes.
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
      const select = { id: true, status: true, created_at: true } as const;
      const where = { payment_id: paymentId, reason: reasonText };
      let refund = await this.prisma.refund.findFirst({ where, select });

      if (refund?.status === 'PROCESADO') return refund.status;

      // Una fila que quedó `PENDIENTE` o `RECHAZADO` (MercadoPago falló, o el
      // proceso murió antes de pedirlo) se reintenta con la misma fila y la
      // misma clave: es seguro porque MercadoPago devuelve el reembolso original
      // en vez de crear otro. Su clave vence a las 24 h: pasado ese plazo no se
      // reintenta, porque podría devolver dos veces; queda para resolverlo a
      // mano.
      if (
        refund &&
        now.getTime() - refund.created_at.getTime() > IDEMPOTENCY_KEY_TTL_MS
      ) {
        this.alertManualRefund(mpPaymentId, reason, refund.status);
        return refund.status;
      }

      const amount = new Prisma.Decimal(params.amount);
      if (!refund) {
        try {
          refund = await this.prisma.refund.create({
            data: { payment_id: paymentId, amount, reason: reasonText },
            select,
          });
        } catch (err) {
          // Dos entregas concurrentes: la otra ganó el índice único parcial
          // (`refunds_payment_reason_uq`). Se sigue con su fila.
          if ((err as { code?: string }).code !== PRISMA_UNIQUE_VIOLATION) {
            throw err;
          }
          refund = await this.prisma.refund.findFirst({ where, select });
          if (!refund) throw err;
          if (refund.status === 'PROCESADO') return refund.status;
        }
      }

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
    /** Sin esto, el porcentaje lo da la política congelada (cancela el paciente). */
    full?: { percent: 100; reason: FullRefundReason },
  ): Promise<CancellationRefund> {
    const appointment = await this.read(appointmentId);

    const unapplied = this.unappliedRefundOf(appointment?.payment);
    if (unapplied) return unapplied;

    const { percent, amount } = this.compute(appointment, now, full?.percent);
    const payment = appointment?.payment;

    // Sin pago aprobado `compute` da monto 0; con la política en 0 % también.
    if (!payment || amount.isZero()) {
      return { percent, amount: amount.toNumber(), status: null };
    }

    // Desde acá el monto ya está calculado: si registrar el reembolso falla se
    // devuelve igual, para que el paciente no vea "$0, pendiente".
    let refund: { id: string };
    try {
      refund = await this.prisma.refund.create({
        data: {
          payment_id: payment.id,
          amount,
          reason: full?.reason ?? CANCELLATION_REASON,
        },
      });
    } catch (err) {
      // Reembolso total ya registrado por otro camino (ADR-018): el índice
      // `refunds_payment_full_refund_uq` frenó el segundo. Se informa el que hay.
      if (full && (err as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.refund.findFirst({
          where: {
            payment_id: payment.id,
            reason: { in: [...FULL_REFUND_REASONS] },
          },
          select: { amount: true, status: true },
        });
        if (existing) {
          return {
            percent,
            amount: existing.amount.toNumber(),
            status: existing.status,
          };
        }
      }
      this.logger.error(
        `REFUND_LOST: no se pudo registrar el reembolso del turno ${appointmentId} (pago ${payment.id}, ${amount.toString()}): ${String(err)}`,
      );
      return { percent, amount: amount.toNumber(), status: 'PENDIENTE' };
    }

    // Pago aprobado sin id de MercadoPago: no hay a quién pedirle la
    // devolución. Antes quedaba PENDIENTE para siempre (ENG-223); ahora queda
    // RECHAZADO con el motivo, visible, y con aviso al equipo (ENG-205).
    if (!payment.mercadopago_payment_id) {
      await this.giveUp(
        refund.id,
        'El pago no tiene ID de MercadoPago: devolverlo a mano.',
        now,
      );
      return { percent, amount: amount.toNumber(), status: 'RECHAZADO' };
    }

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
          attempts: { increment: 1 },
          last_attempt_at: now,
          last_error: null,
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
        `REFUND_FAILED: no se pudo reembolsar el turno ${appointmentId} (refund ${refund.id}): ${String(err)}`,
      );
      // Queda PENDIENTE con el error: lo retoma `retryPending` (ENG-205).
      await this.recordFailedAttempt(refund.id, err, now);
    }

    if (status !== 'PROCESADO') {
      this.logger.warn(
        `Reembolso ${refund.id} del turno ${appointmentId} quedó ${status}: revisarlo a mano.`,
      );
    }

    return { percent, amount: amount.toNumber(), status };
  }

  /**
   * Job (ENG-205, ADR-018 caso 16): retoma los reembolsos PENDIENTE.
   *
   * - **Ya pedido** (`mercadopago_refund_id`): MercadoPago lo dejó en proceso;
   *   se consulta su estado, no se vuelve a pedir.
   * - **Sin respuesta**: antes de volver a pedirlo se mira si MercadoPago ya lo
   *   tiene (`listRefunds`). Así un reintento nunca devuelve dos veces, aunque la
   *   clave de idempotencia haya vencido.
   * - **Espera creciente** entre intentos: 15 min, 30, 1 h... hasta 6 h.
   * - **Pasadas 48 h**, o si el pago no tiene ID de MercadoPago, queda RECHAZADO
   *   con el motivo, el paciente lo ve en su turno y el equipo recibe el aviso.
   *
   * Nunca tira por un reembolso: un error se guarda en la fila y sigue con el
   * siguiente.
   */
  async retryPending(now: Date = new Date()): Promise<RefundRetrySummary> {
    const pending = await this.prisma.refund.findMany({
      where: { status: 'PENDIENTE' },
      select: {
        id: true,
        amount: true,
        reason: true,
        attempts: true,
        last_attempt_at: true,
        created_at: true,
        mercadopago_refund_id: true,
        payment: {
          select: {
            id: true,
            amount: true,
            mercadopago_payment_id: true,
            appointment_id: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
      take: RETRY_BATCH * 4,
    });

    const due = pending
      .filter((r) => isDue(r.attempts, r.last_attempt_at, now))
      .slice(0, RETRY_BATCH);

    const summary: RefundRetrySummary = {
      revisados: 0,
      procesados: 0,
      rechazados: 0,
    };
    for (const row of due) {
      summary.revisados += 1;
      const outcome = await this.retryOne(row, now);
      if (outcome === 'PROCESADO') summary.procesados += 1;
      if (outcome === 'RECHAZADO') summary.rechazados += 1;
      // ENG-208: el paciente se entera de cómo terminó. Nunca tira.
      if (outcome !== 'PENDIENTE') {
        await this.notices.refundUpdated(
          row.payment.appointment_id,
          { refundId: row.id, amount: row.amount.toNumber(), status: outcome },
          now,
        );
      }
    }
    return summary;
  }

  private async retryOne(
    row: {
      id: string;
      amount: Prisma.Decimal;
      reason: string | null;
      created_at: Date;
      mercadopago_refund_id: string | null;
      payment: {
        id: string;
        amount: Prisma.Decimal;
        mercadopago_payment_id: string | null;
      };
    },
    now: Date,
  ): Promise<RefundOutcome> {
    const mpPaymentId = row.payment.mercadopago_payment_id;
    if (!mpPaymentId) {
      await this.giveUp(
        row.id,
        'El pago no tiene ID de MercadoPago: devolverlo a mano.',
        now,
      );
      return 'RECHAZADO';
    }

    const windowEnd =
      row.created_at.getTime() + REFUND_RETRY_WINDOW_HOURS * 3_600_000;

    try {
      let mp: { id: string; status: string } | null = null;
      if (row.mercadopago_refund_id) {
        mp = await this.mercadoPago.getRefund(
          mpPaymentId,
          row.mercadopago_refund_id,
        );
      } else {
        mp = await this.findExistingRefund(mpPaymentId, row);
        if (!mp && now.getTime() < windowEnd) {
          mp = await this.mercadoPago.refundPayment(
            mpPaymentId,
            row.amount.toNumber(),
            idempotencyKeyFor(row, mpPaymentId),
          );
        }
      }

      const status = mp ? toOutcome(mp.status) : 'PENDIENTE';
      if (status === 'PENDIENTE' && now.getTime() >= windowEnd) {
        await this.giveUp(
          row.id,
          `MercadoPago no lo confirmó en ${REFUND_RETRY_WINDOW_HOURS} h: lo resuelve soporte.`,
          now,
        );
        return 'RECHAZADO';
      }

      await this.prisma.refund.update({
        where: { id: row.id },
        data: {
          status,
          mercadopago_refund_id: mp?.id ?? row.mercadopago_refund_id,
          processed_at: status === 'PENDIENTE' ? null : now,
          attempts: { increment: 1 },
          last_attempt_at: now,
          last_error: null,
        },
      });
      if (status === 'PROCESADO')
        await this.markPaymentIfFullyRefunded(row.payment, now);
      if (status === 'RECHAZADO')
        this.alertRejected(row.id, 'MercadoPago lo rechazó');
      return status;
    } catch (err) {
      this.logger.error(
        `REFUND_RETRY_FAILED: refund ${row.id}: ${String(err)}`,
      );
      await this.recordFailedAttempt(row.id, err, now);
      if (now.getTime() >= windowEnd) {
        await this.giveUp(
          row.id,
          `No se pudo procesar en ${REFUND_RETRY_WINDOW_HOURS} h: lo resuelve soporte.`,
          now,
        );
        return 'RECHAZADO';
      }
      return 'PENDIENTE';
    }
  }

  /**
   * Un reembolso de MercadoPago para este pago, del mismo monto, que todavía no
   * esté asociado a ninguna fila nuestra. Es el que se pidió y cuya respuesta se
   * perdió.
   */
  private async findExistingRefund(
    mpPaymentId: string,
    row: { id: string; amount: Prisma.Decimal },
  ): Promise<{ id: string; status: string } | null> {
    const remote = await this.mercadoPago.listRefunds(mpPaymentId);
    const candidates = remote.filter((r) =>
      new Prisma.Decimal(r.amount).equals(row.amount),
    );
    if (candidates.length === 0) return null;
    const linked = await this.prisma.refund.findMany({
      where: {
        mercadopago_refund_id: { in: candidates.map((r) => r.id) },
        id: { not: row.id },
      },
      select: { mercadopago_refund_id: true },
    });
    const taken = new Set(linked.map((r) => r.mercadopago_refund_id));
    return candidates.find((r) => !taken.has(r.id)) ?? null;
  }

  /** El pago pasa a REEMBOLSADO cuando lo procesado cubre el total. */
  private async markPaymentIfFullyRefunded(
    payment: { id: string; amount: Prisma.Decimal },
    now: Date,
  ): Promise<void> {
    const processed = await this.prisma.refund.aggregate({
      where: { payment_id: payment.id, status: 'PROCESADO' },
      _sum: { amount: true },
    });
    if ((processed._sum.amount ?? new Prisma.Decimal(0)).gte(payment.amount)) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'REEMBOLSADO' },
      });
      this.logger.log(
        `Pago ${payment.id} reembolsado entero (${now.toISOString()}).`,
      );
    }
  }

  /** Deja el intento fallido registrado. Nunca tira. */
  private async recordFailedAttempt(
    refundId: string,
    err: unknown,
    now: Date,
  ): Promise<void> {
    try {
      await this.prisma.refund.update({
        where: { id: refundId },
        data: {
          attempts: { increment: 1 },
          last_attempt_at: now,
          last_error: (err instanceof Error ? err.message : String(err)).slice(
            0,
            MAX_ERROR_LENGTH,
          ),
        },
      });
    } catch (writeError) {
      this.logger.error(
        `No se pudo registrar el intento del refund ${refundId}: ${String(writeError)}`,
      );
    }
  }

  /**
   * Se deja de insistir: RECHAZADO con el motivo, visible para el paciente en su
   * turno ("Hubo un problema con el reembolso. Escribinos…") y con aviso al
   * equipo por Sentry. Nunca tira.
   */
  private async giveUp(
    refundId: string,
    motivo: string,
    now: Date,
  ): Promise<void> {
    try {
      const current = await this.prisma.refund.findUnique({
        where: { id: refundId },
        select: { reason: true },
      });
      await this.prisma.refund.update({
        where: { id: refundId },
        data: {
          status: 'RECHAZADO',
          processed_at: now,
          last_error: motivo,
          reason: current?.reason ? `${current.reason} | ${motivo}` : motivo,
        },
      });
    } catch (err) {
      this.logger.error(
        `No se pudo marcar RECHAZADO el refund ${refundId}: ${String(err)}`,
      );
    }
    this.alertRejected(refundId, motivo);
  }

  private alertRejected(refundId: string, motivo: string): void {
    this.logger.error(`REFUND_REJECTED: refund ${refundId}: ${motivo}`);
    Sentry.captureMessage('Reembolso rechazado: requiere gestión manual', {
      level: 'error',
      tags: { feature: 'eng205', refundId },
      extra: { motivo },
    });
  }

  /**
   * La devolución entera que el webhook ya anotó para este pago, si se aprobó
   * cuando el turno ya estaba cancelado (ENG-180).
   *
   * Pasa cuando el pago entra justo mientras el paciente cancela una reserva
   * sin pagar: el UPDATE de `cancel` gana, el webhook ve el turno cancelado y
   * anota `PAGO_SOBRE_TURNO_INACTIVO` **en el mismo commit en que aprueba el
   * pago**. Así que si acá el pago se ve `APROBADO`, esa fila ya está: pedir
   * además la devolución de la política sería devolver dos veces. Se informa la
   * del webhook, que es la del total.
   *
   * No hace falta un lock: el orden inverso no existe, porque sin el commit del
   * webhook el pago no está aprobado y la cancelación no tiene nada que
   * devolver. La fila viene con el turno (`REFUNDABLE_SELECT`), en una sola
   * lectura; el índice único parcial `refunds_payment_reason_uq` (ENG-144)
   * garantiza a lo sumo una por pago.
   */
  private unappliedRefundOf(
    payment: RefundableAppointment['payment'] | undefined,
  ): CancellationRefund | null {
    const refund = payment?.refunds[0];
    if (!refund) return null;

    return {
      percent: 100,
      amount: refund.amount.toNumber(),
      status: refund.status,
    };
  }

  private async read(
    appointmentId: string,
  ): Promise<RefundableAppointment | null> {
    return this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: REFUNDABLE_SELECT,
    });
  }

  /**
   * Porcentaje y monto. Sin pago aprobado no hay nada que devolver.
   *
   * `fixedPercent` saltea la política: es el 100 % de un turno que no se dio
   * por causa del profesional.
   */
  private compute(
    appointment: RefundableAppointment | null,
    now: Date,
    fixedPercent?: number,
  ): { percent: number; amount: Prisma.Decimal } {
    if (!appointment) {
      return { percent: fixedPercent ?? 0, amount: new Prisma.Decimal(0) };
    }

    const { policy } = resolvePolicy({
      hours_full_refund: appointment.policy_hours_full_refund,
      hours_partial_refund: appointment.policy_hours_partial_refund,
      partial_refund_percent: appointment.policy_partial_refund_percent,
    });
    const percent =
      fixedPercent ?? refundPercentFor(policy, appointment.scheduled_at, now);

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

/** Si toca reintentar: espera creciente desde el último intento. */
function isDue(
  attempts: number,
  lastAttemptAt: Date | null,
  now: Date,
): boolean {
  if (!lastAttemptAt) return true;
  const wait = Math.min(
    RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0),
    RETRY_MAX_MS,
  );
  return now.getTime() - lastAttemptAt.getTime() >= wait;
}

/** El estado de MercadoPago traducido al nuestro. */
function toOutcome(mpStatus: string): RefundOutcome {
  if (mpStatus === 'approved') return 'PROCESADO';
  if (mpStatus === 'rejected' || mpStatus === 'cancelled') return 'RECHAZADO';
  return 'PENDIENTE';
}

/**
 * La misma clave con la que se pidió la primera vez: dentro de las 24 h,
 * MercadoPago devuelve el reembolso original en vez de crear otro.
 */
function idempotencyKeyFor(
  row: { id: string; reason: string | null },
  mpPaymentId: string,
): string {
  return row.reason?.startsWith('PAGO_')
    ? `unapplied-${mpPaymentId}`
    : `refund-${row.id}`;
}
