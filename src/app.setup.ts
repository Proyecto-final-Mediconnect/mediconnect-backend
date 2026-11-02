import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { PayloadTooLargeFilter } from './common/filters/payload-too-large.filter';
import { securityHeaders } from './common/http/security-headers';

/**
 * Cableado HTTP de la app (proxy, headers, CORS, pipes y filtros). Vive acá y
 * no en `bootstrap` para que el e2e levante la app con la misma configuración
 * que producción.
 */
export function configureApp(app: NestExpressApplication): void {
  // Detrás de Render, Express confía en un salto de X-Forwarded-For para
  // resolver bien `req.protocol` y `req.secure`.
  //
  // Ojo: esto NO alcanza para que `req.ip` sea el cliente. Delante de Render
  // hay Cloudflare, y con un salto `req.ip` queda en la IP de salida de
  // Cloudflare, compartida por todos los usuarios de la región (medido el
  // 23/09/2026, ENG-84). Por eso el rate limit no usa `req.ip`: identifica al
  // cliente por `CF-Connecting-IP` — ver `ClientIpThrottlerGuard`.
  app.set('trust proxy', 1);
  // Antes que todo lo demás, para que también las respuestas de error los
  // lleven (ENG-166).
  app.use(securityHeaders());
  app.use(cookieParser());
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    credentials: true, // permite enviar/recibir la cookie de sesión httpOnly
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Un archivo por encima del límite del FileInterceptor sale como 413 con el
  // mensaje crudo de Multer ("File too large"). El resto de la API contesta en
  // español; esto lo normaliza.
  app.useGlobalFilters(new PayloadTooLargeFilter());
}
