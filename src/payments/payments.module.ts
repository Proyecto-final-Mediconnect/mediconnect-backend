import { Module } from '@nestjs/common';
import { MercadoPagoService } from './mercadopago.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsWebhookController } from './payments-webhook.controller';

/**
 * EP-04 — Pagos (ADR-013).
 *
 * Tiene el webhook que confirma el turno (ENG-64). `MercadoPagoService` se
 * exporta porque lo consumen ENG-63 (crear la preferencia al reservar) y ENG-65
 * (reembolsos).
 *
 * El banco de pruebas del spike (ENG-61) se sacó al cerrar ENG-64: exponía en
 * producción un endpoint para crear preferencias con montos arbitrarios. Las
 * métricas del spike siguen en `scripts/mercadopago-metrics.ts`, que usa el
 * service directo.
 */
@Module({
  controllers: [PaymentsWebhookController],
  providers: [MercadoPagoService, PaymentWebhookService],
  exports: [MercadoPagoService],
})
export class PaymentsModule {}
