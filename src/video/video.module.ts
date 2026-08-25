import { Module } from '@nestjs/common';
import { DailyService } from './daily.service';
import { VideoController } from './video.controller';

@Module({
  controllers: [VideoController],
  providers: [DailyService],
  // Se exporta porque ENG-56 (videoconsulta desde un turno confirmado) va a
  // reusar el cliente de Daily: el spike deja la pieza, no un experimento suelto.
  exports: [DailyService],
})
export class VideoModule {}
