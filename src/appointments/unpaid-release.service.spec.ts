import { Logger } from '@nestjs/common';
import { AppointmentPaymentService } from '../payments/appointment-payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { UnpaidReleaseService } from './unpaid-release.service';

/**
 * Liberación de turnos impagos (ENG-101).
 *
 * El SQL en sí lo cubre `test/unpaid-release.integration.spec.ts` contra un
 * Postgres real. Acá se verifica lo que pasa alrededor: con qué corte se llama
 * y que cada turno liberado vence su link de pago.
 */

const NOW = new Date('2026-10-14T12:00:00.000Z');
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';
const PATIENT = '11111111-1111-4111-8111-111111111111';

/** Junta el SQL y los valores de un `Prisma.Sql` para poder afirmar sobre ellos. */
function captured(call: unknown[]): { sql: string; values: unknown[] } {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  const flat: unknown[] = [];
  const parts: string[] = [];
  strings.forEach((chunk, i) => {
    parts.push(chunk);
    if (i < values.length) {
      const value = values[i] as { sql?: string; values?: unknown[] };
      if (value && typeof value === 'object' && 'values' in value) {
        parts.push(value.sql ?? '');
        flat.push(...(value.values ?? []));
      } else {
        parts.push('?');
        flat.push(value);
      }
    }
  });
  return { sql: parts.join(''), values: flat };
}

describe('UnpaidReleaseService', () => {
  let prisma: { $queryRaw: jest.Mock };
  let payments: { expireCheckout: jest.Mock };
  let service: UnpaidReleaseService;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    payments = { expireCheckout: jest.fn().mockResolvedValue(undefined) };
    service = new UnpaidReleaseService(
      prisma as unknown as PrismaService,
      payments as unknown as AppointmentPaymentService,
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('libera lo reservado hace 15 minutos o más y devuelve los ids', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);

    const ids = await service.releaseExpired(NOW);

    expect(ids).toEqual(['a1', 'a2']);
    const { values } = captured(prisma.$queryRaw.mock.calls[0] as unknown[]);
    expect(values).toContainEqual(new Date(NOW.getTime() - 15 * 60 * 1000));
  });

  it('vence el link de pago de cada turno liberado', async () => {
    // Si quedó una pestaña de MercadoPago abierta, no tiene que poder cobrar
    // un turno que ya no existe.
    prisma.$queryRaw.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);

    await service.releaseExpired(NOW);

    expect(payments.expireCheckout).toHaveBeenCalledWith('a1', NOW);
    expect(payments.expireCheckout).toHaveBeenCalledWith('a2', NOW);
  });

  it('sin nada para liberar no toca MercadoPago', async () => {
    await service.releaseExpired(NOW);

    expect(payments.expireCheckout).not.toHaveBeenCalled();
  });

  it('sin scope no filtra por profesional ni paciente', async () => {
    await service.releaseExpired(NOW);

    const { sql } = captured(prisma.$queryRaw.mock.calls[0] as unknown[]);
    expect(sql).not.toContain('professional_id =');
    expect(sql).not.toContain('patient_id =');
  });

  it('con scope acota a ese profesional o ese paciente, parametrizado', async () => {
    await service.releaseExpired(NOW, {
      professionalId: PROFESSIONAL,
      patientId: PATIENT,
    });

    const { sql, values } = captured(
      prisma.$queryRaw.mock.calls[0] as unknown[],
    );
    expect(sql).toMatch(/a\.professional_id = .* or a\.patient_id = /s);
    // Los ids viajan como parámetros, nunca concatenados en el SQL.
    expect(sql).not.toContain(PROFESSIONAL);
    expect(values).toEqual(expect.arrayContaining([PROFESSIONAL, PATIENT]));
  });
});
