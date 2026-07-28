import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MeResponseDto } from './dto/me-response.dto';
import { UserService } from './user.service';

@Controller('me')
export class UserController {
  constructor(private readonly userService: UserService) {}

  /**
   * `GET /me` — perfil del usuario autenticado. JwtAuthGuard verifica el token
   * (header `Authorization: Bearer` o cookie `sb-access-token`) y adjunta
   * `request.user`; acá solo usamos su `id` para leer el perfil real desde la
   * base. 401 lo maneja el guard; 404 lo lanza el service si no hay perfil.
   */
  @Get()
  @UseGuards(JwtAuthGuard)
  me(@Req() req: Request): Promise<MeResponseDto> {
    // El guard garantiza `request.user` cuando `canActivate` devuelve true.
    return this.userService.getProfile(req.user!.id);
  }
}
