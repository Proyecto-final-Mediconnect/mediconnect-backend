import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { RegisterProfessionalDto } from './dto/register-professional.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/** Opciones de cookie compartidas por login/logout (deben coincidir para que
 *  `res.clearCookie` efectivamente las borre del browser). */
function sessionCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
  };
}

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
    const base = sessionCookieOptions();
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

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response) {
    // Idempotente y sin Guard: borrar las cookies no requiere que el token
    // siga siendo válido (puede haber expirado y el cliente igual quiere
    // limpiar su estado de sesión).
    const base = sessionCookieOptions();
    res.clearCookie('sb-access-token', base);
    res.clearCookie('sb-refresh-token', base);

    return { message: 'Sesión cerrada.' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: Request) {
    return req.user;
  }
}
