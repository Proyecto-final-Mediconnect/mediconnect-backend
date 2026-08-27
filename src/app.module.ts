import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppointmentsModule } from './appointments/appointments.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { ClinicalRecordsModule } from './clinical-records/clinical-records.module';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { validate } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { PatientsModule } from './patients/patients.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProfessionalsModule } from './professionals/professionals.module';
import { SchedulesModule } from './schedules/schedules.module';
import { SupabaseModule } from './supabase/supabase.module';
import { UserModule } from './user/user.module';
import { VideoModule } from './video/video.module';

@Module({
  imports: [
    // Primero en la lista: registra el contexto de Sentry para el resto de los
    // módulos. Sin `SENTRY_DSN` el SDK está inactivo y esto es un no-op.
    SentryModule.forRoot(),
    ConfigModule.forRoot({ isGlobal: true, validate }),
    // Límite laxo por default (no molesta el uso normal); rutas puntuales
    // como POST /auth/refresh lo endurecen con @Throttle — ver
    // docs/security/refresh-token-reuse-risk-plan.md (mitigación de reuso de
    // refresh tokens no detectado por Supabase).
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
    PrismaModule,
    SupabaseModule,
    AuthModule,
    CatalogModule,
    UserModule,
    HealthModule,
    ProfessionalsModule,
    PatientsModule,
    VideoModule,
    SchedulesModule,
    AppointmentsModule,
    ClinicalRecordsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Captura las excepciones que atraviesan el ciclo de vida de Nest. Sin este
    // filtro solo se reportarían los errores que escapan del framework.
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestLoggerMiddleware)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('*');
  }
}
