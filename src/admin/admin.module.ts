import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  // AuthModule exporta JwtAuthGuard y RolesGuard; NotificationsModule, los
  // avisos al profesional. Prisma llega por el PrismaModule global.
  imports: [AuthModule, NotificationsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
