import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpdatePatientProfileDto } from './dto/update-patient-profile.dto';
import { UpdateVitalInfoDto } from './dto/update-vital-info.dto';
import { PatientsService } from './patients.service';

/** JwtAuthGuard garantiza `user` y `accessToken`; este helper lo hace explícito
 *  para TypeScript sin `!` repartidos por los handlers. */
function requireAuth(req: Request): { userId: string; accessToken: string } {
  if (!req.user?.id || !req.accessToken) {
    throw new UnauthorizedException('No se encontró un token de sesión.');
  }
  return { userId: req.user.id, accessToken: req.accessToken };
}

@Controller('patients')
@UseGuards(JwtAuthGuard)
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Get('me')
  getMyProfile(@Req() req: Request) {
    const { userId, accessToken } = requireAuth(req);
    return this.patients.getMyProfile(accessToken, userId);
  }

  // PUT (no PATCH): el paciente envía SIEMPRE los campos del perfil (los cinco
  // del formulario). La fila no existe hasta la primera carga, así que el upsert
  // necesita todos los obligatorios; un PATCH parcial no podría crearla. `address`
  // no forma parte de este perfil (no está en los criterios de ENG-47): no se
  // gestiona acá y conserva su valor si otro flujo lo cargara.
  @Put('me')
  updateMyProfile(@Req() req: Request, @Body() dto: UpdatePatientProfileDto) {
    const { userId, accessToken } = requireAuth(req);
    return this.patients.updateMyProfile(accessToken, userId, dto);
  }

  /**
   * Los datos vitales del MediPass (ENG-134; los carga ENG-136).
   *
   * Endpoint aparte y no parte de `PUT me` porque las reglas son distintas: los
   * cinco campos del perfil son obligatorios y crean la fila, y estos seis son
   * opcionales y la suponen. Mezclarlos en un PUT dejaría un cuerpo con dos
   * contratos adentro, y obligaría a tocar el formulario de ENG-47.
   *
   * `PUT` y no `PATCH`: reemplaza el bloque entero, que es lo que permite
   * borrar una alergia. Ver `UpdateVitalInfoDto`.
   *
   * Devuelve el perfil completo, igual que `PUT me`, para que la pantalla se
   * quede con lo que quedó guardado sin pedirlo de nuevo.
   */
  @Put('me/vital')
  updateMyVitalInfo(@Req() req: Request, @Body() dto: UpdateVitalInfoDto) {
    const { userId, accessToken } = requireAuth(req);
    return this.patients.updateMyVitalInfo(accessToken, userId, dto);
  }
}
