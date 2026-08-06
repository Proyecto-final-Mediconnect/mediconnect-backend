import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';

/** Mensaje neutral: el 413 puede venir de una subida o de un body demasiado grande. */
export const PAYLOAD_TOO_LARGE_MESSAGE =
  'El contenido que enviaste es demasiado grande.';

/**
 * Normaliza los 413.
 *
 * Cuando un archivo supera el `limits.fileSize` del `FileInterceptor`, Multer
 * aborta y `@nestjs/platform-express` ya lo convierte en `PayloadTooLargeException`
 * (por eso NO sale un 500), pero con el mensaje crudo de Multer: **"File too
 * large"**, en inglés. Toda la API contesta en español, así que se normaliza acá.
 *
 * El caso realista de una foto pesada (entre el tope de la foto y el tope duro del
 * interceptor) ni llega hasta acá: lo atiende `ProfessionalsService` con un 400 que
 * sí explica el límite de 2 MB.
 */
@Catch(PayloadTooLargeException)
export class PayloadTooLargeFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
      statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
      message: PAYLOAD_TOO_LARGE_MESSAGE,
      error: 'Payload Too Large',
    });
  }
}
