import { ForbiddenException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { PrismaService } from '../prisma/prisma.service';
import {
  describeFilters,
  EARNINGS_PAGE_SIZE,
  EarningsService,
} from './earnings.service';

/** Las filas de la hoja como arrays (índice 1 = columna A), sin las vacías. */
async function leerHoja(xlsx: Buffer): Promise<unknown[][]> {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(xlsx as unknown as ArrayBuffer);
  const hoja = libro.getWorksheet('Mis cobros')!;
  return hoja.getSheetValues().filter(Boolean) as unknown[][];
}

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

  describe('filtros', () => {
    beforeEach(() => {
      prisma.payment.findMany.mockResolvedValue([
        pago('t1', '18000.00'),
        pago('t2', '9500.00', [{ amount: '9500.00', status: 'PROCESADO' }], {
          first_name: 'Marina',
          last_name: 'Quiroga',
        }),
        pago('t3', '42000.00', [], {
          first_name: 'Ernesto',
          last_name: 'Núñez',
        }),
      ]);
    });

    it('filtra por estado y los totales salen de las filas filtradas', async () => {
      const vista = await service.list(PRO, { estado: 'REEMBOLSADO' }, NOW);

      expect(vista.rows.map((r) => r.appointmentId)).toEqual(['t2']);
      expect(vista.totals).toMatchObject({ cobrado: 9500, neto: 0, turnos: 1 });
    });

    it('busca por paciente sin importar mayúsculas ni tildes', async () => {
      const vista = await service.list(PRO, { paciente: 'nunez' }, NOW);

      expect(vista.rows.map((r) => r.patient)).toEqual(['Ernesto Núñez']);
    });

    it('la lista de pacientes es la del período entero, ordenada', async () => {
      const vista = await service.list(PRO, { paciente: 'nunez' }, NOW);

      expect(vista.pacientes).toEqual([
        'Ernesto Núñez',
        'Julián Sosa',
        'Marina Quiroga',
      ]);
    });

    it('ordena de la más vieja a la más nueva o por mayor neto', async () => {
      const antiguos = await service.list(PRO, { orden: 'ANTIGUOS' }, NOW);
      const monto = await service.list(PRO, { orden: 'MAYOR_MONTO' }, NOW);

      expect(antiguos.rows.map((r) => r.appointmentId)).toEqual([
        't3',
        't2',
        't1',
      ]);
      expect(monto.rows.map((r) => r.appointmentId)).toEqual([
        't3',
        't1',
        't2',
      ]);
    });

    it('el Excel respeta los mismos filtros', async () => {
      const { xlsx } = await service.exportXlsx(
        PRO,
        { paciente: 'marina' },
        NOW,
      );
      const filas = await leerHoja(xlsx);
      const encabezado = filas.findIndex((f) => f[1] === 'Fecha del cobro');

      expect(String(filas[2][1])).toContain('paciente «marina»');
      expect(filas[encabezado + 1][3]).toBe('Marina Quiroga');
      // Una fila de datos y el total.
      expect(filas).toHaveLength(encabezado + 3);
    });
  });

  describe('Excel', () => {
    it('tiene las mismas filas que la tabla, con fechas y montos de verdad y los totales al pie', async () => {
      prisma.professional.findUnique
        .mockResolvedValueOnce({ currency: 'ARS' })
        .mockResolvedValueOnce({ first_name: 'Ana', last_name: 'García' });
      prisma.payment.findMany.mockResolvedValue([
        pago('t1', '18000.00', [{ amount: '9000.00', status: 'PROCESADO' }], {
          first_name: 'María José',
          last_name: 'Núñez',
        }),
        pago('t2', '9500.50'),
      ]);

      const { filename, xlsx } = await service.exportXlsx(PRO, {}, NOW);
      const filas = await leerHoja(xlsx);

      expect(filename).toBe('mis-cobros-2026-11-01-a-2026-11-20.xlsx');
      expect(filas[0][1]).toBe('Mis cobros');
      expect(String(filas[1][1])).toContain('Ana García');
      expect(String(filas[2][1])).toContain(
        'Cobros del 01/11/2026 al 20/11/2026',
      );
      const encabezado = filas.findIndex((f) => f[1] === 'Fecha del cobro');
      expect(filas[encabezado].slice(1)).toEqual([
        'Fecha del cobro',
        'Turno',
        'Paciente',
        'Cobrado',
        'Reembolsado',
        'Neto',
        'Estado',
      ]);
      const maria = filas[encabezado + 1];
      // Hora de Argentina: la celda guarda la hora local, no la UTC.
      expect((maria[1] as Date).toISOString()).toBe('2026-11-10T10:00:00.000Z');
      expect((maria[2] as Date).toISOString()).toBe('2026-11-12T10:00:00.000Z');
      expect(maria.slice(3)).toEqual([
        'María José Núñez',
        18000,
        9000,
        9000,
        'Reembolsado 50 %',
      ]);
      expect(filas[encabezado + 2].slice(3)).toEqual([
        'Julián Sosa',
        9500.5,
        0,
        9500.5,
        'Cobrado',
      ]);
      const total = filas[filas.length - 1];
      expect(total[1]).toBe('Total');
      expect(total.slice(3, 7)).toEqual(['2 turnos', 27500.5, 9000, 18500.5]);
    });

    it('describe los filtros en una línea', () => {
      expect(
        describeFilters({
          estado: 'REEMBOLSADO',
          paciente: ' julián ',
          orden: 'MAYOR_MONTO',
        }),
      ).toBe(
        'estado «Reembolsado» · paciente «julián» · ordenado por mayor neto primero',
      );
      expect(describeFilters({})).toBe(
        'ordenado por lo último cobrado primero',
      );
    });
  });
});
