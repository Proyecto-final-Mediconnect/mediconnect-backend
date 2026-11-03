import { Module } from '@nestjs/common';
import { MediPassSessionsController } from './medipass-sessions.controller';
import { MediPassController } from './medipass.controller';
import { MediPassService } from './medipass.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * MediPass (EP-05).
 *
 * Dos controllers y no uno porque la diferencia entre ellos es la
 * autenticación, no la ruta: `MediPassController` va detrás de `JwtAuthGuard` y
 * del consentimiento de ENG-140, y `MediPassSessionsController` es público. Que
 * estén en archivos separados hace imposible agregarle una ruta al lado
 * equivocado sin darse cuenta.
 */
@Module({
  // El aviso al paciente cuando alguien abre su MediPass (ENG-177).
  imports: [NotificationsModule],
  controllers: [MediPassController, MediPassSessionsController],
  providers: [MediPassService],
  // El job de cierre de accesos vencidos (ENG-104).
  exports: [MediPassService],
})
export class MediPassModule {}
