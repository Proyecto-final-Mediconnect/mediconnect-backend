import { Module } from '@nestjs/common';
import { StoredFilesController } from './stored-files.controller';
import { StoredFilesService } from './stored-files.service';

/** Archivos clínicos cifrados en Storage (ENG-216, parte 2). */
@Module({
  controllers: [StoredFilesController],
  providers: [StoredFilesService],
  exports: [StoredFilesService],
})
export class StoredFilesModule {}
