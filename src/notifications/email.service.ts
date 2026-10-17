import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const RESEND_API_URL = 'https://api.resend.com';

/** Tope por request: el job manda de a uno y no puede quedar colgado. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Resend no manda dos veces el mismo mensaje con la misma clave (ventana de
   * 24 h). Cubre el caso de que el envío salga pero se caiga la respuesta, y el
   * siguiente intento lo repita.
   */
  idempotencyKey: string;
}

/**
 * Error de envío. `permanent` dice si reintentar tiene sentido: una dirección
 * inválida (400/422) va a fallar igual mañana, pero una caída de Resend, un 429
 * o una API key mal cargada (401/403) se arreglan solos o con un deploy.
 */
export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

/**
 * Envío de emails transaccionales con Resend (ENG-68).
 *
 * Va por la API HTTP con `fetch` y no con el SDK: es un solo endpoint y así no
 * se suma una dependencia.
 *
 * Sin `RESEND_API_KEY` o sin `EMAIL_FROM` el servicio queda apagado: quien lo
 * usa pregunta `isConfigured()` y no manda. Es lo mismo que pasa con Sentry sin
 * DSN, y evita que un entorno de desarrollo mande mails reales.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('RESEND_API_KEY') &&
      this.config.get<string>('EMAIL_FROM'),
    );
  }

  /** Manda el mensaje y devuelve el id de Resend. Tira `EmailDeliveryError`. */
  async send(message: EmailMessage): Promise<string> {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    const from = this.config.get<string>('EMAIL_FROM');
    if (!apiKey || !from) {
      throw new EmailDeliveryError('Email no configurado.', false);
    }

    let response: Response;
    try {
      response = await fetch(`${RESEND_API_URL}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new EmailDeliveryError(
        `No se pudo contactar a Resend: ${String(cause)}`,
        false,
      );
    }

    if (!response.ok) {
      // El cuerpo de error de Resend no trae el destinatario, así que se puede
      // loguear sin filtrar el email del paciente.
      const detail = await response.text().catch(() => '');
      throw new EmailDeliveryError(
        `Resend respondió ${response.status}: ${detail.slice(0, 300)}`,
        response.status === 400 || response.status === 422,
      );
    }

    const body = (await response.json().catch(() => ({}))) as { id?: string };
    return body.id ?? '';
  }
}
