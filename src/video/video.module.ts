import { Module } from '@nestjs/common';
import { DailyService } from './daily.service';
import { TestRoomController } from './test-room.controller';
import { VideoConsultationController } from './video-consultation.controller';
import { VideoConsultationService } from './video-consultation.service';

@Module({
  // ENG-151: el banco de pruebas del spike de Daily (`/video/spike`, ENG-51) se
  // borró. Quedan la videoconsulta (ENG-56) y la prueba de cámara y micrófono.
  controllers: [VideoConsultationController, TestRoomController],
  providers: [DailyService, VideoConsultationService],
  // `DailyService` se exporta desde ENG-51 y lo consume ENG-56 desde este mismo
  // módulo; queda exportado para EP-07, que va a leer las grabaciones.
  exports: [DailyService],
})
export class VideoModule {}
