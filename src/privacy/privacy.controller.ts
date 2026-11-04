import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { SkipLegal } from '../legal/skip-legal.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AccountDeletionService } from './account-deletion.service';
import { DataExportService } from './data-export.service';
import { DeleteAccountDto, FRASE_DE_BAJA } from './dto/delete-account.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { PreferencesService } from './preferences.service';

/**
 * Derechos ARCO de la Ley 25.326 (ENG-86, TT-08 del Sprint 0).
 *
 * | Derecho | Dónde |
 * |---|---|
 * | **Acceso** (art. 14) | `GET /me/data-export`: un JSON con todo lo que se guarda de la persona |
 * | **Rectificación** (art. 16) | Las rutas de perfil que ya existen (`/patients/me`, `/professionals/me`, los datos de emergencia). La HC la corrige el profesional con una entrada nueva (ENG-100) |
 * | **Supresión** (art. 16) | `DELETE /me`: la baja, que anonimiza todo lo que la ley no obliga a conservar |
 * | **Oposición** (art. 27) | `GET`/`PUT /me/preferences`: apagar los recordatorios por email |
 *
 * **Todas con `@SkipLegal()`.** Un derecho no puede depender de aceptar los
 * términos nuevos: alguien que no quiere aceptarlos tiene que poder llevarse
 * sus datos o irse.
 */
@Controller('me')
@UseGuards(JwtAuthGuard)
@SkipLegal()
export class PrivacyController {
  constructor(
    private readonly dataExport: DataExportService,
    private readonly deletion: AccountDeletionService,
    private readonly preferences: PreferencesService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Acceso: descarga el archivo con todos los datos. Límite bajo: es una
   * consulta pesada, y nadie necesita su archivo más de unas pocas veces.
   */
  @Get('data-export')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  async exportData(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { userId } = requireAuth(req);
    const now = new Date();
    const datos = await this.dataExport.export(userId, now);

    // Que conste que se ejerció el derecho, y cuándo. Sin tirar: el archivo
    // ya está armado y un fallo del log no le puede negar sus datos a nadie.
    await this.prisma.auditLog
      .create({
        data: {
          actor_id: userId,
          action: 'ARCO_ACCESS_EXPORT',
          resource_type: 'profiles',
          resource_id: userId,
        },
      })
      .catch(() => undefined);

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="mediconnect-mis-datos-${now.toISOString().slice(0, 10)}.json"`,
    );
    return datos;
  }

  @Get('preferences')
  getPreferences(@Req() req: Request) {
    const { userId } = requireAuth(req);
    return this.preferences.get(userId);
  }

  @Put('preferences')
  updatePreferences(@Req() req: Request, @Body() dto: UpdatePreferencesDto) {
    const { userId } = requireAuth(req);
    return this.preferences.update(userId, dto.recordatoriosPorEmail);
  }

  /** Supresión: da de baja la cuenta. 204, e idempotente si algo quedó a mitad. */
  @Delete()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAccount(
    @Req() req: Request,
    @Body() dto: DeleteAccountDto,
  ): Promise<void> {
    // El `ValidationPipe` global ya la exige. Se repite porque es irreversible:
    // si algún día el pipe se configura distinto, esto no puede quedar abierto.
    if (dto.confirmacion !== FRASE_DE_BAJA) {
      throw new BadRequestException(
        `Escribí "${FRASE_DE_BAJA}" para confirmar.`,
      );
    }
    const { userId, accessToken } = requireAuth(req);
    await this.deletion.deleteMyAccount(userId, accessToken);
  }
}
