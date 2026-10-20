import { Global, Module } from '@nestjs/common';
import { LegalAcceptedGuard } from './legal-accepted.guard';
import { LegalEnforcement } from './legal-enforcement';

/**
 * Global (como PrismaModule y SupabaseModule): `JwtAuthGuard` depende de
 * `LegalAcceptedGuard` y Nest lo instancia en el módulo de cada controller que
 * lo usa, que no siempre importa `AuthModule`.
 */
@Global()
@Module({
  providers: [LegalAcceptedGuard, LegalEnforcement],
  exports: [LegalAcceptedGuard, LegalEnforcement],
})
export class LegalModule {}
