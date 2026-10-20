import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SkipLegal } from '../legal/skip-legal.decorator';
import { OpenEmergencySessionDto } from './dto/open-emergency-session.dto';
import { MediPassService } from './medipass.service';

/**
 * El acceso de emergencia al MediPass (HU-34, ENG-73).
 *
 * **Las dos rutas son públicas y es el único lugar del backend donde se
 * devuelven datos de salud sin sesión.** Quien las usa es un médico de guardia
 * que escaneó un QR con la cámara del celular y no tiene cuenta en la
 * plataforma; la autorización es el código, que vale cinco minutos.
 *
 * Eso las convierte en la superficie de ataque más expuesta del proyecto, y por
 * eso: el rate limit es más duro que el default, el código se valida y se
 * normaliza del lado del servidor aunque la web ya lo haga, y todo rechazo del
 * código contesta lo mismo (ver `CODIGO_INVALIDO`).
 *
 * `@SkipLegal()` es declarativo, como en `CatalogController`: sin
 * `JwtAuthGuard` no hay usuario y no hay consentimiento que chequear. Se marca
 * igual para que quede explícito que acá se decidió, y para que siga andando si
 * algún día la autenticación pasa a ser global.
 */
@Controller('medipass/sessions')
@SkipLegal()
export class MediPassSessionsController {
  constructor(private readonly medipass: MediPassService) {}

  /**
   * Canjea el código y abre el acceso.
   *
   * 10 por minuto por IP real del cliente (ENG-84 da la IP correcta detrás de
   * Cloudflare). El número sale de los dos lados del problema: una guardia
   * entera detrás de un NAT tiene que poder abrir varias fichas seguidas, y al
   * mismo tiempo 10 intentos por minuto no acercan a nadie a adivinar un código
   * de 28^8 combinaciones que además rota cada cinco minutos. La web traduce el
   * 429 a "Demasiados intentos. Esperá un minuto y probá de nuevo".
   */
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  open(@Body() dto: OpenEmergencySessionDto) {
    return this.medipass.openSession(dto);
  }

  /**
   * Si el acceso sigue vivo, con la ficha. 410 cuando venció o se revocó.
   *
   * Límite más alto que el del canje porque la ficha hace polling cada minuto
   * mientras el médico la tiene abierta, y puede haber varias pestañas: esto no
   * es una puerta que se pueda forzar, hace falta un `sesionId` que solo se
   * obtiene canjeando un código.
   */
  @Get(':id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  status(@Param('id') id: string) {
    return this.medipass.getSessionStatus(id);
  }
}
