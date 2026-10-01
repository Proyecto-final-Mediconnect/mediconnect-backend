import { Module } from '@nestjs/common';
import { AppointmentPaymentController } from './appointment-payment.controller';
import { AppointmentPaymentService } from './appointment-payment.service';
import { MercadoPagoService } from './mercadopago.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsSpikeController } from './payments-spike.controller';
import { PaymentsWebhookController } from './payments-webhook.controller';

/**
 * EP-04 — Pagos (ADR-013).
 *
 * Tiene el cobro del turno (ENG-63), el webhook que lo confirma (ENG-64) y el
 * banco de pruebas del spike (ENG-61). El controller del spike se borra cuando
 * los dos primeros estén cerrados.
 *
 * `MercadoPagoService` se exporta porque lo va a necesitar ENG-65 para el
 * reembolso al cancelar.
 */
@Module({
  controllers: [
    PaymentsWebhookController,
    AppointmentPaymentController,
    PaymentsSpikeController,
  ],
  providers: [
    MercadoPagoService,
    PaymentWebhookService,
    AppointmentPaymentService,
  ],
  exports: [MercadoPagoService],
})
export class PaymentsModule {}
