import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { PaymentWebhookService } from './payment-webhook.service';

/**
 * ENG-64 — URL que se registra en el panel de MercadoPago (Webhooks, evento
 * "Pagos") y que ENG-63 manda como `notification_url` de la preferencia.
 *
 * **Público a propósito**: MercadoPago no tiene JWT nuestro; la firma es la
 * barrera y la verifica el service.
 *
 * Contesta 200 incluso con firma inválida o pago desconocido: MercadoPago
 * reintenta con backoff todo lo que no sea 2xx, y reintentar algo que nunca se
 * va a aceptar solo llena la cola. El único non-2xx es cuando falla la API de
 * MercadoPago al pedir el pago, que sí es transitorio.
 */
@Controller('payments/webhooks')
export class PaymentsWebhookController {
  constructor(
    private readonly webhooks: PaymentWebhookService,
    private readonly config: ConfigService,
  ) {}

  @Post('mercadopago')
  @HttpCode(HttpStatus.OK)
  // Todas las notificaciones salen de las pocas IPs de MercadoPago: el límite
  // global de 60/min por IP cortaría ráfagas legítimas (reintentos, varios
  // pagos juntos) y MercadoPago tomaría el 429 como fallo.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async receive(
    @Req() req: Request,
    @Query('data.id') dataIdQuery: string | undefined,
    @Query('id') idQuery: string | undefined,
    @Query('type') typeQuery: string | undefined,
    @Query('topic') topicQuery: string | undefined,
    @Body() payload: unknown,
  ) {
    const body = (
      typeof payload === 'object' && payload !== null ? payload : {}
    ) as { type?: unknown; data?: { id?: unknown } };

    const bodyId = body.data?.id;
    const resultado = await this.webhooks.handle(
      {
        signatureHeader: header(req, 'x-signature'),
        requestId: header(req, 'x-request-id'),
        // `data.id` en el webhook de pagos, `id` en el formato viejo de IPN.
        // El del body va último: la firma se calcula sobre este valor, así que
        // uno inventado simplemente no valida.
        dataId:
          dataIdQuery ??
          idQuery ??
          (typeof bodyId === 'string' || typeof bodyId === 'number'
            ? String(bodyId)
            : undefined),
        topic:
          typeQuery ??
          topicQuery ??
          (typeof body.type === 'string' ? body.type : undefined),
        payload,
      },
      this.config.get<string>('MERCADOPAGO_WEBHOOK_SECRET'),
    );

    return { resultado };
  }
}

/** Header como string. Express los tipa como `string | string[]`. */
function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
