import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProfessionalsModule } from '../professionals/professionals.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PlatformStatsService } from './platform-stats.service';
import { ProfessionalSuspensionService } from './professional-suspension.service';

@Module({
  // AuthModule exporta JwtAuthGuard y RolesGuard; NotificationsModule, los
  // avisos; PaymentsModule, el reembolso y el link de pago de la suspensión;
  // ProfessionalsModule, la actividad. Prisma llega por el PrismaModule global.
  imports: [
    AuthModule,
    NotificationsModule,
    PaymentsModule,
    ProfessionalsModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    ProfessionalSuspensionService,
    PlatformStatsService,
  ],
})
export class AdminModule {}
