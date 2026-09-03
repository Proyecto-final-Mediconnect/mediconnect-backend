import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { CreateSpikePreferenceDto } from './dto/create-spike-preference.dto';
import { verifyWebhookSignature } from './mercadopago-signature';
import { MercadoPagoService } from './mercadopago.service';
import { SPIKE_EXTERNAL_REFERENCE_PREFIX } from './mercadopago.config';

/**
 * Endpoints del spike de MercadoPago (ENG-61).
 *
 * Cuelgan de `/payments/spike` y no de `/payments` a propósito, igual que los de
 * ENG-51 en `/video/spike`: **no son la API de pagos**. La real —crear la
 * preferencia al reservar (ENG-63) y confirmar el turno con el webhook
 * (ENG-64)— vive en otro lado. Estos existen para poder ejecutar y repetir la
 * medición del spike, y el prefijo deja claro que se borran cuando ENG-63 y
 * ENG-64 estén implementados.
 *
 * Los dos primeros piden sesión. El tercero **no puede pedirla**: lo llama
 * MercadoPago, que no tiene un JWT nuestro. Esa es exactamente la asimetría que
 * el spike existe para entender, y la razón por la que la verificación de firma
 * no es opcional.
 */
@Controller('payments/spike')
export class PaymentsSpikeController {
  private readonly logger = new Logger(PaymentsSpikeController.name);

  constructor(
    private readonly mercadopago: MercadoPagoService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Crea una preferencia de prueba y devuelve la URL del Checkout para abrir en
   * el navegador.
   *
   * Rate limit agresivo (5/min contra el default de 60) por el mismo motivo que
   * las salas de Daily: cada preferencia queda registrada en la cuenta de
   * MercadoPago y no hay caso legítimo que necesite más.
   */
  @Post('preferences')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  async createPreference(
    @Req() req: Request,
    @Body() dto: CreateSpikePreferenceDto,
  ) {
    const { userId } = requireAuth(req);
    this.assertSandbox();

    const notificationUrl = this.config.get<string>(
      'MERCADOPAGO_NOTIFICATION_URL',
    );
    if (!notificationUrl) {
      // Sin notification_url el pago se aprueba y el webhook nunca llega, que es
      // justamente el criterio 2 del spike. Falla acá con el motivo en vez de
      // dejar a alguien esperando una notificación que nadie pidió.
      throw new BadRequestException(
        'Falta MERCADOPAGO_NOTIFICATION_URL: sin una URL pública MercadoPago no puede notificar el pago. En local, levantá un túnel.',
      );
    }

    // El external_reference lleva prefijo de spike: en el panel de MercadoPago
    // y en la bitácora de webhooks queda separado de lo que genere un turno real.
    const externalReference = `${SPIKE_EXTERNAL_REFERENCE_PREFIX}-${userId.slice(0, 8)}-${Date.now()}`;

    const preference = await this.mercadopago.createPreference({
      externalReference,
      notificationUrl,
      item: {
        title: dto.title ?? 'Consulta de prueba (spike ENG-61)',
        quantity: 1,
        unitPrice: dto.amount ?? 15_000,
        currencyId: 'ARS',
      },
      // El spike no tiene pantallas de vuelta: las URLs apuntan al front local y
      // solo existen porque `auto_return` las exige. Lo que importa medir es el
      // webhook, no el redirect.
      backUrls: {
        success: 'http://localhost:5173/spike/mercadopago?resultado=ok',
        failure: 'http://localhost:5173/spike/mercadopago?resultado=error',
        pending: 'http://localhost:5173/spike/mercadopago?resultado=pendiente',
      },
      idempotencyKey: externalReference,
    });

    return {
      ...preference,
      // La que hay que abrir es esta: con credenciales de prueba, `initPoint`
      // lleva al checkout productivo y no deja pagar con las tarjetas de test.
      abrirEsta: preference.sandboxInitPoint,
    };
  }

  /** Estado real de un pago según MercadoPago. Es la consulta que ENG-64 hace
   *  al recibir el webhook, expuesta para poder mirarla a mano. */
  @Get('payments/:id')
  @UseGuards(JwtAuthGuard)
  getPayment(@Param('id') id: string) {
    this.assertSandbox();
    return this.mercadopago.getPayment(id);
  }

  /**
   * Recibe el webhook de MercadoPago y verifica la firma (criterio 2 del spike).
   *
   * **Público a propósito.** MercadoPago no manda un JWT nuestro, así que este
   * endpoint no puede pasar por `JwtAuthGuard` y la firma es la única barrera.
   * No toca la base ni confirma nada: reporta si la firma valida y qué dice
   * MercadoPago del pago. Quien escribe es ENG-64.
   *
   * Contesta 200 SIEMPRE, incluso con la firma inválida. No es descuido: es el
   * comportamiento que ENG-64 necesita heredar. MercadoPago reintenta con
   * backoff cualquier notificación que no reciba un 2xx, así que contestar 401 a
   * un atacante nos regala reintentos automáticos del proveedor y llena la cola
   * de una notificación que nunca vamos a aceptar. Lo que pasó queda en el log y
   * en el cuerpo de la respuesta, no en el status.
   */
  @Post('webhooks/mercadopago')
  @HttpCode(HttpStatus.OK)
  async receiveWebhook(
    @Req() req: Request,
    @Query('data.id') dataIdQuery: string | undefined,
    @Query('id') idQuery: string | undefined,
    @Body() payload: unknown,
  ) {
    const secret = this.config.get<string>('MERCADOPAGO_WEBHOOK_SECRET');
    if (!secret) {
      // Sin secreto no se puede verificar nada, y procesar sin verificar es
      // peor que no procesar: el endpoint es público.
      this.logger.error(
        'Llegó un webhook de MercadoPago pero falta MERCADOPAGO_WEBHOOK_SECRET: no se verificó nada.',
      );
      return { verificada: false, motivo: 'sin-secreto-configurado' };
    }

    // MercadoPago manda el id como `data.id` en el webhook de pagos y como `id`
    // en el formato viejo de IPN. Se aceptan los dos: el spike existe para
    // descubrir cuál llega de verdad, y anotarlo en el informe.
    const dataId = dataIdQuery ?? idQuery ?? readDataIdFromBody(payload);

    const check = verifyWebhookSignature({
      signatureHeader: header(req, 'x-signature'),
      requestId: header(req, 'x-request-id'),
      dataId,
      secret,
    });

    if (!check.valid) {
      this.logger.warn(
        `Webhook de MercadoPago rechazado (${check.reason}) para data.id=${dataId ?? 'ausente'}`,
      );
      return { verificada: false, motivo: check.reason };
    }

    this.logger.log(`Webhook de MercadoPago verificado para data.id=${dataId}`);

    // La firma cubre el manifest, no el body: el estado se vuelve a pedir a la
    // API en vez de leerlo del JSON que llegó. Es la conclusión que ENG-64
    // implementa.
    const payment = await this.mercadopago.getPayment(dataId as string);

    return { verificada: true, pago: payment };
  }

  /**
   * El spike nunca corre contra credenciales productivas.
   *
   * Sandbox y producción comparten host: si alguien deja un `APP_USR-` en el
   * `.env`, estos endpoints crearían cobros reales sin que nada lo delate. El
   * chequeo va acá y no en el service porque es una regla del spike, no de la
   * integración: ENG-63 sí tiene que poder cobrar de verdad.
   */
  private assertSandbox(): void {
    if (!this.mercadopago.isConfigured()) return; // el service tira el 503 explicado
    if (!this.mercadopago.isSandbox()) {
      throw new ForbiddenException(
        'El spike de ENG-61 solo corre con credenciales de prueba (MERCADOPAGO_ACCESS_TOKEN con prefijo TEST-).',
      );
    }
  }
}

/** Header como string. Express los tipa como `string | string[]`. */
function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Último recurso: algunos reintentos de MercadoPago traen el id solo en el
 *  cuerpo. Se lee sin confiar —la firma se calcula igual sobre este valor, así
 *  que un id inventado acá simplemente no valida. */
function readDataIdFromBody(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const data = (payload as { data?: { id?: unknown } }).data;
  const id = data?.id;
  return typeof id === 'string' || typeof id === 'number'
    ? String(id)
    : undefined;
}
