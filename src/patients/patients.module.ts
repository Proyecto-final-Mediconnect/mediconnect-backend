import { Module } from '@nestjs/common';
import { PatientsController } from './patients.controller';
import { PatientSummaryService } from './patient-summary.service';
import { PatientsService } from './patients.service';

@Module({
  controllers: [PatientsController],
  providers: [PatientsService, PatientSummaryService],
})
export class PatientsModule {}
