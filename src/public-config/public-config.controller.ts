import { Controller, Get, Header } from '@nestjs/common';
import { PUBLIC_CONFIG, type PublicConfig } from './public-config';

/**
 * `GET /config` — las reglas de negocio que muestran la web y la app (ENG-229).
 *
 * Pública y sin `JwtAuthGuard`: la landing y el registro también las usan, y no
 * dice nada de nadie. Es lo único de la API que se puede cachear (cinco
 * minutos): cambia solo con un deploy.
 */
@Controller('config')
export class PublicConfigController {
  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  get(): PublicConfig {
    return PUBLIC_CONFIG;
  }
}
