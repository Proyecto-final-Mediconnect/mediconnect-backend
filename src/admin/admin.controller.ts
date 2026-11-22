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
  type AdminProfessionalDetail,
  type AdminProfessionalPage,
  type AdminProfile,
  type LicenseQueueItem,
} from './admin.service';
import { AccountReasonDto } from './dto/account-reason.dto';
import { DecideLicenseDto } from './dto/decide-license.dto';
import { LicenseQueueQueryDto } from './dto/license-queue-query.dto';
import { ListProfessionalsAdminQueryDto } from './dto/list-professionals-query.dto';
import {
  ProfessionalSuspensionService,
  type SuspensionImpact,
} from './professional-suspension.service';

/**
 * Administración de la plataforma (ENG-220): todo lo de `/admin` es solo para
 * el rol `ADMINISTRADOR`, el equipo de MediConnect. El guard va a nivel de
 * controller, así ningún endpoint nuevo queda abierto por olvido.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMINISTRADOR')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly suspension: ProfessionalSuspensionService,
  ) {}

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
   * `GET /admin/professionals?status=&q=&page=` (ENG-241): el listado, con la
   * actividad de cada uno. Va después de `professionals/licenses` a propósito:
   * las rutas fijas se registran antes que `professionals/:id`.
   */
  @Get('professionals')
  professionals(
    @Query() query: ListProfessionalsAdminQueryDto,
  ): Promise<AdminProfessionalPage> {
    return this.admin.listProfessionals(query);
  }

  /** `GET /admin/professionals/:id` (ENG-241): el detalle con su actividad. */
  @Get('professionals/:id')
  professional(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminProfessionalDetail> {
    return this.admin.professionalDetail(id);
  }

  /**
   * `GET /admin/professionals/:id/suspension-preview` (ENG-241): cuántos
   * turnos se resolverían al suspenderlo, para mostrarlo antes de confirmar.
   */
  @Get('professionals/:id/suspension-preview')
  suspensionPreview(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SuspensionImpact> {
    return this.suspension.preview(id);
  }

  /**
   * `PATCH /admin/professionals/:id/suspension` (ENG-241): suspende a un
   * profesional validado. Sus turnos pagados se reembolsan al 100 % y los
   * impagos se cancelan.
   */
  @Patch('professionals/:id/suspension')
  suspend(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AccountReasonDto,
  ) {
    return this.suspension.suspend(requireAuth(req).userId, id, dto.reason);
  }

  /** `PATCH /admin/professionals/:id/reactivation` (ENG-241). */
  @Patch('professionals/:id/reactivation')
  reactivate(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AccountReasonDto,
  ) {
    return this.suspension.reactivate(requireAuth(req).userId, id, dto.reason);
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
