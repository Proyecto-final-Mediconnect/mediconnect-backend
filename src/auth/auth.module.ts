import { Module } from '@nestjs/common';
import { AuthMobileController } from './auth-mobile.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';

@Module({
  controllers: [AuthController, AuthMobileController, MfaController],
  providers: [AuthService, JwtAuthGuard, MfaService],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
