import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { RegisterProfessionalDto } from './dto/register-professional.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  registerPatient(@Body() dto: RegisterPatientDto) {
    return this.authService.registerPatient(dto);
  }

  @Post('register/professional')
  @HttpCode(HttpStatus.CREATED)
  registerProfessional(@Body() dto: RegisterProfessionalDto) {
    return this.authService.registerProfessional(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.authService.login(dto);

    // La sesión se guarda en cookies httpOnly (no accesibles por JS → mitiga
    // robo de token vía XSS). El cliente no recibe los tokens en el body.
    const isProd = process.env.NODE_ENV === 'production';
    const base = {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax' as const,
      path: '/',
    };
    res.cookie('sb-access-token', session.accessToken, {
      ...base,
      maxAge: 60 * 60 * 1000, // 1 h
    });
    res.cookie('sb-refresh-token', session.refreshToken, {
      ...base,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
    });

    return { user: session.user };
  }
}
