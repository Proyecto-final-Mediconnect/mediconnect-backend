import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { PlatformStatsService } from './platform-stats.service';

/** ENG-195 — los bordes que la integración no cubre. */
describe('PlatformStatsService', () => {
  const vacio = () => ({
    profile: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    professional: { groupBy: jest.fn().mockResolvedValue([]) },
    appointment: { groupBy: jest.fn().mockResolvedValue([]) },
    payment: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { amount: null }, _count: { _all: 0 } }),
    },
    refund: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
    },
    review: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _avg: { rating: null }, _count: { _all: 0 } }),
    },
    integrityCheck: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  });

  it('si la verificación de integridad nunca corrió, lo dice con null', async () => {
    const service = new PlatformStatsService(
      vacio() as unknown as PrismaService,
    );

    const stats = await service.get(
      { from: '2026-09-01', to: '2026-11-30' },
      new Date('2026-11-22T12:00:00Z'),
    );

    expect(stats.integridad).toBeNull();
    expect(stats.cobros).toEqual({
      moneda: 'ARS',
      cobrado: 0,
      reembolsado: 0,
      neto: 0,
      pagos: 0,
    });
    expect(stats.turnos.porMes.map((m) => m.mes)).toEqual([
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
  });

  it('una corrida con error o sin detalle no rompe la tarjeta', async () => {
    const prisma = vacio();
    prisma.integrityCheck.findFirst.mockResolvedValue({
      run_at: new Date('2026-11-17T03:00:00Z'),
      status: 'ERROR',
      inconsistencies_found: 0,
      details: { patients_checked: 'no es un número' },
    });
    const service = new PlatformStatsService(
      prisma as unknown as PrismaService,
    );

    const stats = await service.get({}, new Date('2026-11-22T12:00:00Z'));

    expect(stats.integridad).toEqual({
      at: '2026-11-17T03:00:00.000Z',
      status: 'ERROR',
      inconsistencies: 0,
      patientsChecked: null,
      entriesChecked: null,
    });
    // Sin período, los últimos 3 meses, como "Mi actividad".
    expect(stats.from).toBe('2026-09-01');
    expect(stats.to).toBe('2026-11-30');
  });

  it('un período al revés da 400', async () => {
    const service = new PlatformStatsService(
      vacio() as unknown as PrismaService,
    );

    await expect(
      service.get({ from: '2026-11-30', to: '2026-09-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
