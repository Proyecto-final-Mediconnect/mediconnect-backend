import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Cliente Prisma como provider de Nest: abre la conexión al iniciar el módulo
 * y la cierra al destruirlo (evita fugas de conexiones en tests e2e y en
 * shutdown). El cliente generado vive en `generated/prisma` (ver schema.prisma).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
