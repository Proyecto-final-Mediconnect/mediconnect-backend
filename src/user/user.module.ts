import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UserController } from './user.controller';
import { UserService } from './user.service';

@Module({
  // AuthModule exporta JwtAuthGuard (que depende de SupabaseService). Prisma
  // llega vía el PrismaModule global.
  imports: [AuthModule],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
