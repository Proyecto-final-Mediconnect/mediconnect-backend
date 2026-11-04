import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountDeletionService } from './account-deletion.service';
import { DataExportService } from './data-export.service';
import { PreferencesService } from './preferences.service';
import { PrivacyController } from './privacy.controller';

/** Derechos ARCO de la Ley 25.326 (ENG-86). Prisma y Supabase llegan globales. */
@Module({
  imports: [AuthModule],
  controllers: [PrivacyController],
  providers: [DataExportService, AccountDeletionService, PreferencesService],
})
export class PrivacyModule {}
