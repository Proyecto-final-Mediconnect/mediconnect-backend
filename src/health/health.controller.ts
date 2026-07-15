import { Controller, Get } from '@nestjs/common';

/**
 * Health check del backend (doc §3.5.6).
 *
 * Lo consume el cron de keepalive de GitHub Actions cada 10 minutos para mitigar
 * el cold start de Render Free, y sirve como sonda de estado del servicio.
 *
 * Devuelve 200 con un payload mínimo. A diferencia de `/`, que renderiza una
 * página para el usuario, esta ruta es un contrato estable para monitoreo: no
 * cambia de forma aunque cambie la UI.
 *
 * TODO(ENG-38): cuando Prisma esté cableado en la app, reportar también el
 * estado de la conexión a la BD, como pide el doc.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
