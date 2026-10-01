import { Module } from '@nestjs/common';
import { AppointmentPaymentController } from './appointment-payment.controller';
import { AppointmentPaymentService } from './appointment-payment.service';
import { MercadoPagoService } from './mercadopago.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsWebhookController } from './payments-webhook.controller';

/**
 * EP-04 — Pagos (ADR-013).
 *
 * Tiene el cobro del turno (ENG-63) y el webhook que lo confirma (ENG-64).
 * `MercadoPagoService` se exporta porque lo va a necesitar ENG-65 para el
 * reembolso al cancelar.
 *
 * El banco de pruebas del spike (ENG-61) se sacó al cerrar ENG-64: exponía en
 * producción un endpoint para crear preferencias con montos arbitrarios. Las
 * métricas del spike siguen en `scripts/mercadopago-metrics.ts`, que usa el
 * service directo.
 */
@Module({
  controllers: [PaymentsWebhookController, AppointmentPaymentController],
  providers: [
    MercadoPagoService,
    PaymentWebhookService,
    AppointmentPaymentService,
  ],
  exports: [MercadoPagoService],
})
export class PaymentsModule {}
