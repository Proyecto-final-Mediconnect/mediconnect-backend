import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AppointmentPaymentController } from './appointment-payment.controller';
import { AppointmentPaymentService } from './appointment-payment.service';
import { CancellationRefundService } from './cancellation-refund.service';
import { MercadoPagoService } from './mercadopago.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsWebhookController } from './payments-webhook.controller';

/**
 * EP-04 — Pagos (ADR-013).
 *
 * Tiene el cobro del turno (ENG-63) y el webhook que lo confirma (ENG-64).
 * La cancelación (ENG-55) usa `AppointmentPaymentService` para vencer el link
 * de pago del turno y `CancellationRefundService` para el reembolso (ENG-65).
 *
 * El banco de pruebas del spike (ENG-61) se sacó al cerrar ENG-64: exponía en
 * producción un endpoint para crear preferencias con montos arbitrarios. Las
 * métricas del spike siguen en `scripts/mercadopago-metrics.ts`, que usa el
 * service directo.
 */
@Module({
  // El webhook manda el email de confirmación al confirmar el turno (ENG-68).
  imports: [NotificationsModule],
  controllers: [PaymentsWebhookController, AppointmentPaymentController],
  providers: [
    MercadoPagoService,
    PaymentWebhookService,
    AppointmentPaymentService,
    CancellationRefundService,
  ],
  exports: [
    MercadoPagoService,
    AppointmentPaymentService,
    CancellationRefundService,
  ],
})
export class PaymentsModule {}
