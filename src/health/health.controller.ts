import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipLegal } from '../legal/skip-legal.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Cuánto se espera a la base antes de darla por caída. Un `SELECT 1` sano tarda
 * milisegundos; si tarda segundos, para el usuario la base está caída igual.
 */
export const DB_CHECK_TIMEOUT_MS = 3_000;

export interface HealthReport {
  status: 'ok';
  db: 'ok';
  timestamp: string;
}

/**
 * Health check del backend (doc §3.5.6, ENG-228).
 *
 * Responde 200 solo si el proceso está vivo **y** la base contesta un
 * `SELECT 1` dentro de `DB_CHECK_TIMEOUT_MS`. Si la base no contesta, 503: un
 * monitor externo detecta la caída real, que antes quedaba oculta detrás de un
 * "ok" fijo.
 *
 * Es un contrato estable para monitoreo: no cambia de forma aunque cambie la UI.
 * No expone detalles del error (versión, host, mensaje de Postgres); esos van al
 * log.
 */
// Pública: sin usuario no hay consentimiento que exigir (ENG-140).
@SkipLegal()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<HealthReport> {
    const timestamp = new Date().toISOString();
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, DB_CHECK_TIMEOUT_MS);
    } catch (error) {
      this.logger.error(`Health: la base no responde: ${String(error)}`);
      throw new ServiceUnavailableException({
        status: 'error',
        db: 'down',
        timestamp,
      });
    }
    return { status: 'ok', db: 'ok', timestamp };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`sin respuesta en ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
