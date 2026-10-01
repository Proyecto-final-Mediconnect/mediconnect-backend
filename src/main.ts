// Debe ir primero: instrumenta los módulos antes de que se carguen (ver
// `instrument.ts`). Mover este import más abajo rompe la captura en silencio.
import './instrument';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { PayloadTooLargeFilter } from './common/filters/payload-too-large.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Detrás de Render, Express confía en un salto de X-Forwarded-For para
  // resolver bien `req.protocol` y `req.secure`.
  //
  // Ojo: esto NO alcanza para que `req.ip` sea el cliente. Delante de Render
  // hay Cloudflare, y con un salto `req.ip` queda en la IP de salida de
  // Cloudflare, compartida por todos los usuarios de la región (medido el
  // 23/09/2026, ENG-84). Por eso el rate limit no usa `req.ip`: identifica al
  // cliente por `CF-Connecting-IP` — ver `ClientIpThrottlerGuard`.
  app.set('trust proxy', 1);
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
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
