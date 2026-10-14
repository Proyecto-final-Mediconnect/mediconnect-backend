import { Global, Module } from '@nestjs/common';
import { LegalAcceptedGuard } from './legal-accepted.guard';

/**
 * Global (como PrismaModule y SupabaseModule): `JwtAuthGuard` depende de
 * `LegalAcceptedGuard` y Nest lo instancia en el módulo de cada controller que
 * lo usa, que no siempre importa `AuthModule`.
 */
@Global()
@Module({
  providers: [LegalAcceptedGuard],
  exports: [LegalAcceptedGuard],
})
export class LegalModule {}
