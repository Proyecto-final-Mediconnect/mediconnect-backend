import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { MediPassService } from './medipass.service';

/**
 * El MediPass del propio paciente (HU-32 y HU-33; ENG-72, ENG-103).
 *
 * Pasa por `JwtAuthGuard`, que además exige la aceptación vigente de los textos
 * legales (ENG-140) salvo con `@SkipLegal()`. Acá **no** se marca, y es a
 * propósito: el bloque vital son datos de salud, que es justamente el alcance
 * del consentimiento que ENG-140 pide. Un paciente que no aceptó no tiene por
 * qué poder generar un código que abre su ficha clínica.
 *
 * No hay un guard de roles en el proyecto, así que "solo pacientes" lo sostiene
 * `MediPassService`: las dos rutas necesitan la fila de `patients` del usuario y
 * un profesional no tiene ninguna, así que recibe un 409 y nunca datos de otro.
 */
@Controller('medipass')
@UseGuards(JwtAuthGuard)
export class MediPassController {
  constructor(private readonly medipass: MediPassService) {}

  /** El código vigente para armar el QR, y cuándo rota. */
  @Get('me')
  getMyCode(@Req() req: Request) {
    const { userId } = requireAuth(req);
    return this.medipass.getMyCode(userId);
  }

  /**
   * Lo que va a ver quien escanee. Que el paciente lo vea **antes** de mostrar
   * el QR es parte del punto: si no sabe qué está compartiendo, el control sobre
   * su información es nominal.
   */
  @Get('me/vital')
  getMyVitalBlock(@Req() req: Request) {
    const { userId } = requireAuth(req);
    return this.medipass.getMyVitalBlock(userId);
  }
}
