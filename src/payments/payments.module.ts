import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
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
 * reembolso al cancelar, y `AppointmentPaymentService` porque la cancelación
 * (ENG-55) vence el link de pago del turno.
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
  ],
  exports: [MercadoPagoService, AppointmentPaymentService],
})
export class PaymentsModule {}
