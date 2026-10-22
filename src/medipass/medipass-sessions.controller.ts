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
import { CanjeGlobalThrottle } from './canje-global-throttle.decorator';
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
 * eso: el canje lleva un rate limit más duro que el default **y** un techo
 * global (ENG-170), el código se valida y se normaliza del lado del servidor
 * aunque la web ya lo haga, y todo rechazo del código contesta lo mismo (ver
 * `CODIGO_INVALIDO`).
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
   * **Dos límites, y hacen falta los dos.**
   *
   * 10 por minuto **por IP** real del cliente (ENG-84 da la IP correcta detrás
   * de Cloudflare). El número sale de los dos lados del problema: una guardia
   * entera detrás de un NAT tiene que poder abrir varias fichas seguidas, y al
   * mismo tiempo 10 intentos por minuto no acercan a nadie a adivinar un código
   * de 28^8 combinaciones que además rota cada cinco minutos. La web traduce el
   * 429 a "Demasiados intentos. Esperá un minuto y probá de nuevo".
   *
   * Y `@CanjeGlobalThrottle()`, el techo global (ENG-170, hallazgo 2 de
   * ENG-105). El límite por IP no frena el ataque que importa: un atacante no
   * quiere la ficha de alguien en particular sino *una* de cualquiera, así que
   * reparte los intentos entre muchas IPs y nunca alcanza el límite de ninguna.
   * Con una botnet de 10.000 IPs son 100.000 intentos por minuto y el 50 % de
   * probabilidad de sacar una ficha al azar en 1,8 días. Ver
   * `CANJE_GLOBAL_LIMIT` para el número y el tradeoff.
   */
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @CanjeGlobalThrottle()
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
