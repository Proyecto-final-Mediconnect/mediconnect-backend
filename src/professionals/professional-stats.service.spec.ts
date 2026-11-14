import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import {
  lastMonths,
  monthsBetween,
  ProfessionalStatsService,
  tasa,
} from './professional-stats.service';

const PRO = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-14T15:00:00.000Z');

function grupo(status: string, n: number) {
  return { status, _count: { _all: n } };
}

function consulta(patient_id: string, scheduled_at: string) {
  return { patient_id, scheduled_at: new Date(scheduled_at) };
}

/** ENG-196 — "Mi actividad" del profesional. */
describe('ProfessionalStatsService', () => {
  let prisma: {
    professional: { findUnique: jest.Mock };
    appointment: { groupBy: jest.Mock; count: jest.Mock; findMany: jest.Mock };
    review: { aggregate: jest.Mock; count: jest.Mock };
  };
  let service: ProfessionalStatsService;

  beforeEach(() => {
    prisma = {
      professional: {
        findUnique: jest.fn().mockResolvedValue({ profile_id: PRO }),
      },
      appointment: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      review: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _avg: { rating: null }, _count: { _all: 0 } }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new ProfessionalStatsService(prisma as unknown as PrismaService);
  });

  it('cuenta los turnos por cómo terminaron, sin los reservados sin pagar', async () => {
    prisma.appointment.groupBy.mockResolvedValue([
      grupo('COMPLETADO', 20),
      grupo('NO_ASISTIO', 2),
      grupo('CANCELADO', 3),
      grupo('LIBERADO', 4),
      grupo('RESERVADO_SIN_PAGAR', 1),
      grupo('CONFIRMADO', 6),
    ]);
    prisma.appointment.count.mockResolvedValue(5);

    const stats = await service.get(PRO, {}, NOW);

    expect(stats.turnos).toEqual({
      completados: 20,
      noAsistio: 2,
      cancelados: 3,
      liberados: 4,
      porVenir: 5,
    });
  });

  it('"por venir" son los confirmados posteriores a ahora dentro del período', async () => {
    await service.get(PRO, {}, NOW);

    expect(prisma.appointment.count).toHaveBeenCalledWith({
      where: {
        professional_id: PRO,
        status: 'CONFIRMADO',
        scheduled_at: { gt: NOW, lt: new Date('2026-12-01T03:00:00.000Z') },
      },
    });
  });

  it('calcula las tasas con su base: cancelación sobre los que llegaron o se cayeron, ausentismo sobre los que había que ir', async () => {
    prisma.appointment.groupBy.mockResolvedValue([
      grupo('COMPLETADO', 21),
      grupo('NO_ASISTIO', 2),
      grupo('CANCELADO', 2),
      grupo('LIBERADO', 7),
    ]);

    const { tasas } = await service.get(PRO, {}, NOW);

    expect(tasas.cancelacion).toEqual({
      porcentaje: 8,
      numerador: 2,
      denominador: 25,
    });
    expect(tasas.ausentismo).toEqual({
      porcentaje: 8.7,
      numerador: 2,
      denominador: 23,
    });
  });

  it('sin denominador la tasa es null y no 0 %', async () => {
    prisma.appointment.groupBy.mockResolvedValue([grupo('CANCELADO', 1)]);

    const { tasas } = await service.get(PRO, {}, NOW);

    expect(tasas.cancelacion).toEqual({
      porcentaje: 100,
      numerador: 1,
      denominador: 1,
    });
    expect(tasas.ausentismo).toBeNull();
    expect(tasa(0, 0)).toBeNull();
  });

  it('cuenta pacientes únicos y recurrentes con las consultas completadas', async () => {
    prisma.appointment.findMany.mockResolvedValue([
      consulta('p1', '2026-09-10T13:00:00.000Z'),
      consulta('p1', '2026-10-10T13:00:00.000Z'),
      consulta('p2', '2026-10-11T13:00:00.000Z'),
      consulta('p3', '2026-11-02T13:00:00.000Z'),
      consulta('p3', '2026-11-09T13:00:00.000Z'),
      consulta('p3', '2026-11-12T13:00:00.000Z'),
    ]);

    const { pacientes } = await service.get(PRO, {}, NOW);

    expect(pacientes).toEqual({ unicos: 3, recurrentes: 2 });
  });

  it('agrupa las consultas por mes en hora de Argentina, con los meses en 0', async () => {
    prisma.appointment.findMany.mockResolvedValue([
      // 1 de octubre 01:00 UTC = 30 de septiembre 22:00 en Argentina.
      consulta('p1', '2026-10-01T01:00:00.000Z'),
      consulta('p2', '2026-11-03T13:00:00.000Z'),
    ]);

    const stats = await service.get(
      PRO,
      { from: '2026-08-01', to: '2026-11-30' },
      NOW,
    );

    expect(stats.consultasPorMes).toEqual([
      { mes: '2026-08', consultas: 0 },
      { mes: '2026-09', consultas: 1 },
      { mes: '2026-10', consultas: 0 },
      { mes: '2026-11', consultas: 1 },
    ]);
  });

  it('promedia solo las reseñas aprobadas del período y cuenta las sin responder', async () => {
    prisma.review.aggregate.mockResolvedValue({
      _avg: { rating: 4.666 },
      _count: { _all: 12 },
    });
    prisma.review.count.mockResolvedValue(2);

    const { resenas } = await service.get(PRO, {}, NOW);

    expect(resenas).toEqual({ promedio: 4.7, cantidad: 12, sinResponder: 2 });
    const periodo = {
      gte: new Date('2026-09-01T03:00:00.000Z'),
      lt: new Date('2026-12-01T03:00:00.000Z'),
    };
    expect(prisma.review.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          professional_id: PRO,
          status: 'APROBADA',
          created_at: periodo,
        },
      }),
    );
    expect(prisma.review.count).toHaveBeenCalledWith({
      where: {
        professional_id: PRO,
        status: 'APROBADA',
        created_at: periodo,
        response: { is: null },
      },
    });
  });

  it('un período vacío devuelve ceros, tasas y promedio null, y los meses en 0', async () => {
    const stats = await service.get(PRO, {}, NOW);

    expect(stats).toEqual({
      from: '2026-09-01',
      to: '2026-11-30',
      turnos: {
        completados: 0,
        noAsistio: 0,
        cancelados: 0,
        liberados: 0,
        porVenir: 0,
      },
      tasas: { cancelacion: null, ausentismo: null },
      consultasPorMes: [
        { mes: '2026-09', consultas: 0 },
        { mes: '2026-10', consultas: 0 },
        { mes: '2026-11', consultas: 0 },
      ],
      pacientes: { unicos: 0, recurrentes: 0 },
      resenas: { promedio: null, cantidad: 0, sinResponder: 0 },
    });
  });

  it('filtra los turnos del período por scheduled_at y del profesional del JWT', async () => {
    await service.get(PRO, { from: '2026-10-01', to: '2026-10-31' }, NOW);

    expect(prisma.appointment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          professional_id: PRO,
          scheduled_at: {
            gte: new Date('2026-10-01T03:00:00.000Z'),
            lt: new Date('2026-11-01T03:00:00.000Z'),
          },
        },
      }),
    );
  });

  it('un paciente (sin fila de profesional) recibe 403 y no se consulta nada más', async () => {
    prisma.professional.findUnique.mockResolvedValue(null);

    await expect(service.get(PRO, {}, NOW)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.appointment.groupBy).not.toHaveBeenCalled();
  });

  it('rechaza un período al revés', async () => {
    await expect(
      service.get(PRO, { from: '2026-11-10', to: '2026-11-01' }, NOW),
    ).rejects.toThrow('posterior');
  });

  describe('períodos', () => {
    it('por defecto, los últimos tres meses enteros', () => {
      expect(lastMonths(3, NOW)).toEqual({
        from: '2026-09-01',
        to: '2026-11-30',
      });
      expect(lastMonths(12, new Date('2027-02-10T15:00:00.000Z'))).toEqual({
        from: '2026-03-01',
        to: '2027-02-28',
      });
    });

    it('lista los meses que toca un período, cruzando el año', () => {
      expect(monthsBetween('2026-11-15', '2027-02-03')).toEqual([
        '2026-11',
        '2026-12',
        '2027-01',
        '2027-02',
      ]);
    });
  });
});
