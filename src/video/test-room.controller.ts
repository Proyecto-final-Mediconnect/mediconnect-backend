import {
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  UserThrottled,
  UserThrottlerGuard,
} from '../common/throttler/user-throttler.guard';
import { DailyService, type TestRoom } from './daily.service';

/**
 * "Probar cámara y micrófono": una sala de Daily para una sola persona, en
 * cualquier momento y sin turno (ver `test-room.config.ts`).
 *
 * La pueden usar los tres roles: el paciente antes de su consulta y el
 * profesional antes de empezar el día.
 */
@Controller('video/test-room')
@UseGuards(JwtAuthGuard)
export class TestRoomController {
  constructor(private readonly daily: DailyService) {}

  /**
   * Crea la sala y devuelve su URL con el token.
   *
   * `POST` porque crea una sala en Daily, y `no-store` porque la URL lleva la
   * credencial adentro. 3 por minuto por usuario: cada sala es una llamada a un
   * proveedor que factura, y probar la cámara tres veces seguidas ya es mucho.
   * Por usuario y no por IP: en un consultorio o una red compartida, una IP
   * agotaría el cupo de todos.
   */
  @Post()
  @UseGuards(UserThrottlerGuard)
  @UserThrottled()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  create(): Promise<TestRoom> {
    // El nombre que se ve en la pantalla previa. La sala es de una sola
    // persona, así que no hace falta que diga quién es.
    return this.daily.createTestRoom('Vos');
  }
}
