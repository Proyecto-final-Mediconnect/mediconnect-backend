import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** Por defecto; `EXPO_PUSH_URL` lo pisa para apuntar a un mock. */
const DEFAULT_EXPO_PUSH_URL = 'https://exp.host';

/** Tope por request: mandar el push no puede demorar la respuesta del chat. */
const REQUEST_TIMEOUT_MS = 5_000;

/** Expo acepta hasta 100 mensajes por request. */
const MAX_MESSAGES_PER_REQUEST = 100;

/** El canal de Android donde caen los avisos de mensajes (lo crea la app). */
export const MESSAGES_CHANNEL_ID = 'mensajes';

/** `ExponentPushToken[...]` o `ExpoPushToken[...]`: lo que da `getExpoPushTokenAsync`. */
export const EXPO_PUSH_TOKEN_PATTERN =
  /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

export interface PushMessage {
  title: string;
  body: string;
  /** Lo que la app lee al tocar la notificación. No se muestra. */
  data: Record<string, string>;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/**
 * Notificaciones push a la app mobile por Expo Push (ENG-71).
 *
 * Va por la API HTTP con `fetch`, como los emails de ENG-68: es un solo
 * endpoint y así no se suma el SDK. Expo entrega por FCM en Android con las
 * credenciales cargadas en EAS; el backend no las ve.
 *
 * El push es un aviso extra, no la fuente de verdad: el mensaje ya quedó
 * guardado y con su aviso in-app. Por eso **`sendToUser` nunca tira** y no
 * reintenta:
 * - un error **permanente** (`DeviceNotRegistered`: la app se desinstaló o el
 *   token venció) borra el token, para no volver a mandarle;
 * - uno **transitorio** (Expo caído, timeout, 429) solo se loguea: el próximo
 *   mensaje vuelve a intentar.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Guarda el token del dispositivo para el usuario. Si el token ya era de otra
   * persona (un celular compartido en el que cambió la sesión), pasa al nuevo
   * usuario: el anterior no tiene que seguir recibiendo sus avisos ahí.
   */
  async register(
    userId: string,
    token: string,
    platform: string | undefined,
  ): Promise<void> {
    await this.prisma.pushToken.upsert({
      where: { token },
      create: { user_id: userId, token, platform: platform ?? null },
      update: { user_id: userId, platform: platform ?? null },
    });
  }

  /** Borra el token del usuario al cerrar sesión. Uno ajeno no se toca. */
  async unregister(userId: string, token: string): Promise<void> {
    await this.prisma.pushToken.deleteMany({
      where: { token, user_id: userId },
    });
  }

  /** Manda el push a todos los dispositivos del usuario. **Nunca tira.** */
  async sendToUser(userId: string, message: PushMessage): Promise<void> {
    try {
      const tokens = (
        await this.prisma.pushToken.findMany({
          where: { user_id: userId },
          select: { token: true },
          take: MAX_MESSAGES_PER_REQUEST,
        })
      ).map((t) => t.token);
      if (tokens.length === 0) return;

      const tickets = await this.post(
        tokens.map((to) => ({
          to,
          title: message.title,
          body: message.body,
          data: message.data,
          sound: 'default',
          priority: 'high',
          channelId: MESSAGES_CHANNEL_ID,
        })),
      );
      if (!tickets) return;

      // Los tickets vuelven en el mismo orden que los mensajes.
      // TODO(ENG-71): `DeviceNotRegistered` a veces no llega en el ticket sino
      // en el receipt (`/--/api/v2/push/getReceipts` con los ids de los tickets,
      // minutos después). Sin consultarlos, esos tokens muertos quedan hasta que
      // un ticket posterior devuelva el error. Sumarlo como job si molesta.
      const unregistered = tokens.filter(
        (_, i) =>
          tickets[i]?.status === 'error' &&
          tickets[i]?.details?.error === 'DeviceNotRegistered',
      );
      if (unregistered.length > 0) {
        await this.prisma.pushToken.deleteMany({
          where: { token: { in: unregistered } },
        });
      }
      const otherErrors = tickets.filter(
        (t) =>
          t.status === 'error' && t.details?.error !== 'DeviceNotRegistered',
      );
      if (otherErrors.length > 0) {
        // El mensaje de Expo no trae el texto del push, así que se puede loguear.
        this.logger.warn(
          `Expo rechazó ${otherErrors.length} push(es): ${otherErrors
            .map((t) => t.details?.error ?? t.message ?? 'sin detalle')
            .join(', ')}`,
        );
      }
    } catch (err) {
      this.logger.error(`No se pudo mandar el push: ${String(err)}`);
    }
  }

  /** `null` si el envío falló entero (transitorio): ya quedó logueado. */
  private async post(messages: object[]): Promise<ExpoTicket[] | null> {
    const baseUrl =
      this.config.get<string>('EXPO_PUSH_URL') ?? DEFAULT_EXPO_PUSH_URL;
    const accessToken = this.config.get<string>('EXPO_ACCESS_TOKEN');

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/--/api/v2/push/send`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          // Solo si el proyecto de Expo exige "Enhanced Security for Push".
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      this.logger.warn(`No se pudo contactar a Expo Push: ${String(cause)}`);
      return null;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.warn(
        `Expo Push respondió ${response.status}: ${detail.slice(0, 300)}`,
      );
      return null;
    }

    const body = (await response.json().catch(() => ({}))) as {
      data?: ExpoTicket[];
    };
    return Array.isArray(body.data) ? body.data : null;
  }
}
