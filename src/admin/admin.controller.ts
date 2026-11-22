import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { requireAuth } from '../common/http/require-auth';
import { AdminService, type AdminProfile } from './admin.service';

/**
 * Administración de la plataforma (ENG-220): todo lo de `/admin` es solo para
 * el rol `ADMINISTRADOR`, el equipo de MediConnect. El guard va a nivel de
 * controller, así ningún endpoint nuevo queda abierto por olvido.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMINISTRADOR')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /**
   * `GET /admin/me`: quién administra. La web lo usa para confirmar el acceso
   * al panel con el backend, no solo con el rol que tiene en memoria.
   */
  @Get('me')
  me(@Req() req: Request): Promise<AdminProfile> {
    return this.admin.profile(requireAuth(req).userId);
  }
}
