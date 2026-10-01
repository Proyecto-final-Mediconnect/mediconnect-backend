import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Payment } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { verifyWebhookSignature } from './mercadopago-signature';
import { MercadoPagoPayment, MercadoPagoService } from './mercadopago.service';
import { APPROVED_STATUS } from './mercadopago.config';

/** Lo que llega por HTTP, sin interpretar. El controller no decide nada. */
export interface IncomingWebhook {
  signatureHeader: string | undefined;
  requestId: string | undefined;
  dataId: string | undefined;
  /** `payment`, `merchant_order`, ... Llega como `type` o, en IPN, `topic`. */
  topic: string | undefined;
  payload: unknown;
}

/**
 * Qué se hizo con la notificación. Va al log y a la respuesta (que MercadoPago
 * ignora); el status HTTP es 200 en todos los casos menos cuando conviene que
 * MercadoPago reintente, y ahí el service tira.
 */
export type WebhookOutcome =
  | 'firma-invalida'
  | 'sin-secreto-configurado'
  | 'tipo-ignorado'
  | 'pago-desconocido'
  | 'monto-no-coincide'
  | 'ya-procesado'
  | 'turno-confirmado'
  | 'turno-no-confirmable'
  | 'pago-rechazado'
  | 'pago-pendiente'
  | 'estado-no-manejado';

/** Estados de MercadoPago que significan "este intento no cobró". */
const REJECTED_STATUSES = ['rejected', 'cancelled'];
/** Todavía no hay resultado: llega otra notificación cuando lo haya. */
const PENDING_STATUSES = ['pending', 'in_process', 'authorized'];

/**
 * ENG-64 — confirma el turno cuando MercadoPago avisa que el pago se aprobó.
 *
 * El flujo sale de las conclusiones del spike (ENG-61):
 *
 * 1. **La firma no cubre el body.** MercadoPago firma `data.id + x-request-id +
 *    ts`. Una firma válida solo prueba que hubo una notificación sobre ese pago,
 *    así que el estado, el monto y el turno se leen de `GET /v1/payments/:id`,
 *    nunca del JSON que llegó.
 * 2. **El turno sale de `external_reference`**, que ENG-63 pone con el id del
 *    turno al crear la preferencia. Se busca el `Payment` por `appointment_id`.
 * 3. **Idempotente.** MercadoPago reintenta y manda duplicados (`payment.created`
 *    y `payment.updated` del mismo pago). Las transiciones son `updateMany` con
 *    el estado de origen en el `where`: si otro webhook ya movió la fila, el
 *    conteo es 0 y no se pisa nada.
 *
 * El webhook es público (MercadoPago no tiene JWT nuestro) y escribe por el
 * owner de Prisma, que bypassea RLS: toda la autorización es la firma más los
 * chequeos de acá.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mercadopago: MercadoPagoService,
  ) {}

  async handle(
    incoming: IncomingWebhook,
    secret: string | undefined,
    now: Date = new Date(),
  ): Promise<WebhookOutcome> {
    if (!secret) {
      // Procesar sin verificar es peor que no procesar: el endpoint es público.
      this.logger.error(
        'Llegó un webhook de MercadoPago pero falta MERCADOPAGO_WEBHOOK_SECRET: se descarta sin verificar.',
      );
      return 'sin-secreto-configurado';
    }

    const check = verifyWebhookSignature({
      signatureHeader: incoming.signatureHeader,
      requestId: incoming.requestId,
      dataId: incoming.dataId,
      secret,
      now,
    });
    if (!check.valid) {
      // Sin escribir en la base: una notificación sin firma válida no merece
      // fila, y escribir le daría a cualquiera una forma de llenar la tabla.
      this.logger.warn(
        `Webhook de MercadoPago rechazado (${check.reason}) para data.id=${incoming.dataId ?? 'ausente'}`,
      );
      return 'firma-invalida';
    }

    // `merchant_order` y demás no confirman nada: el pago tiene su propia
    // notificación. Sin `topic` se asume pago, que es el único tipo que se
    // suscribe en el panel.
    if (incoming.topic && incoming.topic !== 'payment') {
      return 'tipo-ignorado';
    }

    const mpPaymentId = incoming.dataId as string;

    // Si la API de MercadoPago falla, esto tira y el controller contesta 5xx:
    // es el único caso en el que queremos que MercadoPago reintente.
    const mpPayment = await this.mercadopago.getPayment(mpPaymentId);

    const payment = mpPayment.externalReference
      ? await this.prisma.payment.findUnique({
          where: { appointment_id: mpPayment.externalReference },
        })
      : null;

    const event = await this.prisma.paymentWebhookEvent.create({
      data: {
        payment_id: payment?.id ?? null,
        mercadopago_payment_id: mpPaymentId,
        raw_payload: incoming.payload ?? {},
        signature: incoming.signatureHeader ?? null,
      },
    });

    const outcome = await this.apply(payment, mpPayment, now);

    await this.prisma.paymentWebhookEvent.update({
      where: { id: event.id },
      // `processed` = se llegó a una decisión sobre el pago. Un pago que no
      // matchea con nada queda en false para revisarlo a mano.
      data: {
        processed: outcome !== 'pago-desconocido',
        processed_at: now,
      },
    });

    this.logger.log(
      `Webhook de MercadoPago payment_id=${mpPaymentId} status=${mpPayment.status} → ${outcome}`,
    );
    return outcome;
  }

  private async apply(
    payment: Payment | null,
    mpPayment: MercadoPagoPayment,
    now: Date,
  ): Promise<WebhookOutcome> {
    if (!payment) {
      // O la preferencia se creó sin `external_reference` (bug nuestro), o es
      // un pago de otra integración de la misma cuenta. No hay nada que
      // reintentar: 200 y queda en la bitácora sin procesar.
      this.logger.error(
        `Pago de MercadoPago ${mpPayment.id} sin Payment asociado (external_reference=${mpPayment.externalReference ?? 'ausente'}).`,
      );
      return 'pago-desconocido';
    }

    if (mpPayment.status === APPROVED_STATUS) {
      return this.approve(payment, mpPayment, now);
    }

    if (REJECTED_STATUSES.includes(mpPayment.status)) {
      // Checkout Pro deja reintentar con otra tarjeta sobre la misma
      // preferencia: un rechazo no cierra nada. Solo se marca si el pago seguía
      // pendiente, para no pisar un APROBADO que llegó antes. El turno queda
      // RESERVADO_SIN_PAGAR y lo libera el vencimiento de ENG-101.
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDIENTE' },
        data: {
          status: 'RECHAZADO',
          mercadopago_payment_id: mpPayment.id,
          method: mpPayment.paymentMethodId,
        },
      });
      return 'pago-rechazado';
    }

    if (PENDING_STATUSES.includes(mpPayment.status)) {
      return 'pago-pendiente';
    }

    // `refunded` y `charged_back` son de ENG-65 (reembolsos). Quedan en la
    // bitácora y en el log hasta que ese flujo exista.
    this.logger.warn(
      `Estado de MercadoPago no manejado: ${mpPayment.status} (payment_id=${mpPayment.id}).`,
    );
    return 'estado-no-manejado';
  }

  private async approve(
    payment: Payment,
    mpPayment: MercadoPagoPayment,
    now: Date,
  ): Promise<WebhookOutcome> {
    // El monto lo fija nuestra preferencia, pero se compara igual: es lo que
    // MercadoPago efectivamente cobró, y confirmar un turno por menos de lo que
    // vale no se arregla después.
    const paidEnough =
      mpPayment.currencyId === payment.currency &&
      new Prisma.Decimal(mpPayment.transactionAmount).gte(payment.amount);
    if (!paidEnough) {
      this.logger.error(
        `Pago ${mpPayment.id} aprobado por ${mpPayment.transactionAmount} ${mpPayment.currencyId}, el turno ${payment.appointment_id} vale ${payment.amount.toString()} ${payment.currency}. No se confirma.`,
      );
      return 'monto-no-coincide';
    }

    return this.prisma.$transaction(async (tx) => {
      // RECHAZADO también es origen válido: un intento rechazado seguido de uno
      // aprobado sobre la misma preferencia.
      const paid = await tx.payment.updateMany({
        where: { id: payment.id, status: { in: ['PENDIENTE', 'RECHAZADO'] } },
        data: {
          status: 'APROBADO',
          mercadopago_payment_id: mpPayment.id,
          method: mpPayment.paymentMethodId,
          confirmed_at: mpPayment.approvedAt
            ? new Date(mpPayment.approvedAt)
            : now,
        },
      });
      if (paid.count === 0) return 'ya-procesado' as const;

      // Solo un turno que sigue esperando el pago pasa a CONFIRMADO. Si entre
      // la reserva y el pago el paciente lo canceló o ENG-101 lo liberó, el
      // pago queda APROBADO pero el turno no revive: hay que devolver la plata
      // (ENG-65), y el log es la señal.
      const confirmed = await tx.appointment.updateMany({
        where: { id: payment.appointment_id, status: 'RESERVADO_SIN_PAGAR' },
        data: { status: 'CONFIRMADO', updated_at: now },
      });
      if (confirmed.count === 0) {
        this.logger.error(
          `Pago ${mpPayment.id} aprobado pero el turno ${payment.appointment_id} ya no estaba RESERVADO_SIN_PAGAR: requiere reembolso.`,
        );
        return 'turno-no-confirmable' as const;
      }
      return 'turno-confirmado' as const;
    });
  }
}
