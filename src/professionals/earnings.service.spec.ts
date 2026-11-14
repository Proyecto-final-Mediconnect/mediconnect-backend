import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { EARNINGS_PAGE_SIZE, EarningsService, toCsv } from './earnings.service';

const PRO = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-20T15:00:00.000Z');

function pago(
  id: string,
  amount: string,
  refunds: { amount: string; status: string }[] = [],
  paciente = { first_name: 'Julián', last_name: 'Sosa' },
) {
  return {
    amount,
    confirmed_at: new Date('2026-11-10T13:00:00.000Z'),
    refunds,
    appointment: {
      id,
      scheduled_at: new Date('2026-11-12T13:00:00.000Z'),
      patient: paciente,
    },
  };
}

/** ENG-194 — "Mis cobros" del profesional. */
describe('EarningsService', () => {
  let prisma: {
    professional: { findUnique: jest.Mock };
    payment: { findMany: jest.Mock };
  };
  let service: EarningsService;

  beforeEach(() => {
    prisma = {
      professional: {
        findUnique: jest.fn().mockResolvedValue({ currency: 'ARS' }),
      },
      payment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new EarningsService(prisma as unknown as PrismaService);
  });

  it('suma lo cobrado menos lo reembolsado del período', async () => {
    prisma.payment.findMany.mockResolvedValue([
      pago('t1', '18000.00'),
      pago('t2', '18000.00', [{ amount: '9000.00', status: 'PROCESADO' }]),
      pago('t3', '9500.50'),
    ]);

    const vista = await service.list(PRO, {}, NOW);

    expect(vista.totals).toEqual({
      cobrado: 45500.5,
      reembolsado: 9000,
      neto: 36500.5,
      pendiente: 0,
      turnos: 3,
    });
  });

  it('un reembolso parcial descuenta solo lo devuelto y dice el porcentaje', async () => {
    prisma.payment.findMany.mockResolvedValue([
      pago('t1', '18000.00', [{ amount: '9000.00', status: 'PROCESADO' }]),
    ]);

    const [fila] = (await service.list(PRO, {}, NOW)).rows;

    expect(fila).toMatchObject({
      amount: 18000,
      refunded: 9000,
      net: 9000,
      state: 'REEMBOLSO_PARCIAL',
      refundPercent: 50,
    });
  });

  it('un reembolso pendiente no se descuenta todavía y uno rechazado no devolvió nada', async () => {
    prisma.payment.findMany.mockResolvedValue([
      pago('t1', '18000.00', [{ amount: '18000.00', status: 'PENDIENTE' }]),
      pago('t2', '18000.00', [{ amount: '18000.00', status: 'RECHAZADO' }]),
    ]);

    const vista = await service.list(PRO, {}, NOW);

    expect(vista.rows.map((r) => r.state)).toEqual([
      'REEMBOLSO_PENDIENTE',
      'COBRADO',
    ]);
    expect(vista.totals).toMatchObject({ neto: 36000, pendiente: 18000 });
  });

  it('solo pide pagos acreditados de sus turnos, acreditados en el período', async () => {
    await service.list(PRO, { from: '2026-11-01', to: '2026-11-30' }, NOW);

    const [{ where }] = prisma.payment.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    // Un turno impago o liberado no tiene pago acreditado: no entra.
    expect(where).toEqual({
      status: { in: ['APROBADO', 'REEMBOLSADO'] },
      confirmed_at: {
        gte: new Date('2026-11-01T03:00:00.000Z'),
        lt: new Date('2026-12-01T03:00:00.000Z'),
      },
      appointment: { professional_id: PRO },
    });
  });

  it('sin período, el mes en curso en Argentina', async () => {
    const vista = await service.list(PRO, {}, NOW);
    expect(vista).toMatchObject({ from: '2026-11-01', to: '2026-11-20' });
  });

  it('pagina la tabla pero los totales son del período entero', async () => {
    prisma.payment.findMany.mockResolvedValue(
      Array.from({ length: EARNINGS_PAGE_SIZE + 3 }, (_, i) =>
        pago(`t${i}`, '1000.00'),
      ),
    );

    const segunda = await service.list(PRO, { pagina: 2 }, NOW);

    expect(segunda.rows).toHaveLength(3);
    expect(segunda.hayMas).toBe(false);
    expect(segunda.totals.turnos).toBe(EARNINGS_PAGE_SIZE + 3);
  });

  it('quien no es profesional recibe 403 y no se lee ningún pago', async () => {
    prisma.professional.findUnique.mockResolvedValue(null);

    await expect(service.list(PRO, {}, NOW)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  it('un período al revés da 400', async () => {
    await expect(
      service.list(PRO, { from: '2026-11-30', to: '2026-11-01' }, NOW),
    ).rejects.toThrow('posterior');
  });

  describe('CSV', () => {
    it('tiene las mismas filas que la tabla, con ; y coma decimal para Excel', async () => {
      prisma.payment.findMany.mockResolvedValue([
        pago('t1', '18000.00', [{ amount: '9000.00', status: 'PROCESADO' }], {
          first_name: 'María José',
          last_name: 'Núñez',
        }),
        pago('t2', '9500.50'),
      ]);

      const { filename, csv } = await service.exportCsv(PRO, {}, NOW);
      const lineas = csv.replace('﻿', '').trim().split('\r\n');

      expect(filename).toBe('cobros-2026-11-01-a-2026-11-20.csv');
      expect(csv.startsWith('﻿')).toBe(true);
      expect(lineas).toEqual([
        'Fecha del cobro;Turno;Paciente;Cobrado;Reembolsado;Neto;Estado',
        '2026-11-10;2026-11-12 10:00;María José Núñez;18000,00;9000,00;9000,00;Reembolsado 50 %',
        '2026-11-10;2026-11-12 10:00;Julián Sosa;9500,50;0,00;9500,50;Cobrado',
      ]);
    });

    it('escapa un nombre con ; o comillas', () => {
      const csv = toCsv([
        {
          appointmentId: 't1',
          paidAt: '2026-11-10T13:00:00.000Z',
          date: '2026-11-12',
          startTime: '10:00',
          patient: 'Ana "Anita"; Pérez',
          amount: 1,
          refunded: 0,
          refundPending: 0,
          net: 1,
          state: 'COBRADO',
          refundPercent: null,
        },
      ]);
      expect(csv).toContain('"Ana ""Anita""; Pérez"');
    });
  });
});
