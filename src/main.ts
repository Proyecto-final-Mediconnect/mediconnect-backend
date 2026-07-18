import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Detrás de un reverse proxy (Nginx/Cloudflare/Railway/Render), `req.ip`
  // sería la IP del proxy y ThrottlerGuard limitaría a TODOS los usuarios
  // como uno solo (rompe el rate limit por IP de POST /auth/refresh y el
  // límite default global). Confiamos en el primer hop de X-Forwarded-For.
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
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
