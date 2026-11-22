import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { requireAuth } from '../common/http/require-auth';
import {
  AdminService,
  type AdminProfile,
  type LicenseQueueItem,
} from './admin.service';
import { DecideLicenseDto } from './dto/decide-license.dto';
import { LicenseQueueQueryDto } from './dto/license-queue-query.dto';

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

  /**
   * `GET /admin/professionals/licenses?status=…` (ENG-192): la cola de
   * matrículas. Sin `status`, las pendientes.
   */
  @Get('professionals/licenses')
  licenses(@Query() query: LicenseQueueQueryDto): Promise<LicenseQueueItem[]> {
    return this.admin.licenseQueue(
      query.status ?? 'PENDIENTE_VALIDACION_MATRICULA',
    );
  }

  /**
   * `PATCH /admin/professionals/:id/license` (ENG-192): valida o rechaza la
   * matrícula de un profesional pendiente. 409 si ya tiene una decisión.
   */
  @Patch('professionals/:id/license')
  decideLicense(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideLicenseDto,
  ) {
    return this.admin.decideLicense(requireAuth(req).userId, id, dto);
  }
}
