import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Global (como SupabaseModule): cualquier módulo inyecta PrismaService sin
 *  reimportarlo. Fuente única de acceso a la base vía Prisma. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
