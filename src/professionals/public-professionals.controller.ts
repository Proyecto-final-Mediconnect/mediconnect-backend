import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { PublicProfessionalsService } from './public-professionals.service';

/**
 * Perfil público de un profesional (ENG-50). SIN `JwtAuthGuard` a propósito:
 * verlo no requiere autenticación. El service expone solo profesionales
 * VALIDADO y un subconjunto acotado de campos.
 *
 * Comparte prefijo `professionals` con `ProfessionalsController` (rutas `/me`,
 * protegidas). Ese controller se registra primero en el módulo, así que
 * `GET /professionals/me` resuelve a la ruta estática antes que a `:id`; además
 * `ParseUUIDPipe` haría 400 si algo no-UUID llegara hasta acá.
 */
@Controller('professionals')
export class PublicProfessionalsController {
  constructor(
    private readonly publicProfessionals: PublicProfessionalsService,
  ) {}

  @Get(':id')
  getPublicProfile(@Param('id', ParseUUIDPipe) id: string) {
    return this.publicProfessionals.getPublicProfile(id);
  }
}
