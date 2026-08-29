import { Module } from '@nestjs/common';
import { DailyService } from './daily.service';
import { VideoConsultationController } from './video-consultation.controller';
import { VideoConsultationService } from './video-consultation.service';
import { VideoController } from './video.controller';

@Module({
  // `VideoController` es el banco de pruebas del spike (ENG-51) y sigue acá a
  // propósito: ENG-51 todavía no pudo tomar las métricas de la llamada de 30
  // minutos (criterio 3), y esa medición se corre desde `/spike/daily`. Se borra
  // junto con la página de la web cuando ese criterio esté cerrado, no antes.
  controllers: [VideoController, VideoConsultationController],
  providers: [DailyService, VideoConsultationService],
  // `DailyService` se exporta desde ENG-51 y lo consume ENG-56 desde este mismo
  // módulo; queda exportado para EP-07, que va a leer las grabaciones.
  exports: [DailyService],
})
export class VideoModule {}
