import { Module } from '@nestjs/common';
import { MercadoPagoService } from './mercadopago.service';
import { PaymentsSpikeController } from './payments-spike.controller';

/**
 * EP-04 — Pagos (ADR-013).
 *
 * Hoy tiene solo el banco de pruebas del spike (ENG-61). `MercadoPagoService` se
 * exporta porque lo van a consumir ENG-63 (crear la preferencia al reservar) y
 * ENG-64 (confirmar el turno con el webhook), y el controller del spike se borra
 * cuando esos dos estén cerrados.
 */
@Module({
  controllers: [PaymentsSpikeController],
  providers: [MercadoPagoService],
  exports: [MercadoPagoService],
})
export class PaymentsModule {}
