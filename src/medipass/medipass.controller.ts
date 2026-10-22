import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { MediPassService } from './medipass.service';

/**
 * El MediPass del propio paciente (HU-32, HU-33, HU-35 y HU-36; ENG-72,
 * ENG-103, ENG-74, ENG-75).
 *
 * Pasa por `JwtAuthGuard`, que además exige la aceptación vigente de los textos
 * legales (ENG-140) salvo con `@SkipLegal()`. Acá **no** se marca, y es a
 * propósito: el bloque vital son datos de salud, que es justamente el alcance
 * del consentimiento que ENG-140 pide. Un paciente que no aceptó no tiene por
 * qué poder generar un código que abre su ficha clínica.
 *
 * No hay un guard de roles en el proyecto, así que "solo pacientes" lo sostiene
 * `MediPassService`: `me`, `me/vital` y `me/accesses` necesitan la fila de
 * `patients` del usuario y un profesional no tiene ninguna, así que recibe un
 * 409 y nunca datos de otro. El `DELETE` no la necesita, y ahí el filtro es la
 * pertenencia de la sesión: `revokeAccess` compara el `patient_id` de la fila
 * contra el del token antes de tocar nada.
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

  /**
   * Quién está mirando la ficha ahora mismo (HU-35, ENG-74).
   *
   * La pantalla la consulta cada vez que se abre y mientras el QR está visible,
   * así que es una lectura barata a propósito: una consulta con índice
   * `(patient_id, expires_at)` y sin escrituras. **No** deja rastro en
   * `medipass_access_logs`: que el paciente mire su propia lista no es un acceso
   * de un tercero a su ficha, y meterlo ahí ensuciaría justo la bitácora que
   * ENG-76 existe para que pueda leer.
   */
  @Get('me/accesses')
  listMyAccesses(@Req() req: Request) {
    const { userId } = requireAuth(req);
    return this.medipass.listMyAccesses(userId);
  }

  /**
   * Cortar un acceso (HU-36, ENG-75).
   *
   * `DELETE` y no `POST .../revoke` porque para el paciente el recurso es el
   * acceso y la acción es sacarlo de su lista; la fila queda con `revoked_at`,
   * pero eso es detalle de implementación y de la auditoría, no del contrato.
   *
   * 204 sin cuerpo: no hay nada que devolver, y la pantalla recarga la lista.
   * Es idempotente —cortar dos veces el mismo acceso da 204 las dos veces— así
   * que un doble click del paciente no le muestra un error.
   *
   * Sin `@Throttle` propio: el límite global alcanza. Es una escritura, pero no
   * habla con ningún proveedor externo y el único que puede llamarla es el
   * dueño de la sesión, sobre sus propias filas. Poner un límite bajo acá
   * sería, en el peor momento, frenarle al paciente lo único que quiere hacer.
   */
  @Delete('me/accesses/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeAccess(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    const { userId } = requireAuth(req);
    await this.medipass.revokeAccess(userId, id);
  }
}
