import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import {
  MY_PATIENTS_PAGE_SIZE,
  MyPatientsService,
  toCsv,
} from './my-patients.service';

const PRO = '22222222-2222-4222-8222-222222222222';
const JULIAN = '33333333-3333-4333-8333-333333333333';
const ANA = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-14T15:00:00.000Z');

function turno(
  patientId: string,
  scheduledAt: string,
  status: string,
  paciente = { first_name: 'Julián', last_name: 'Sosa' },
) {
  return {
    patient_id: patientId,
    scheduled_at: new Date(scheduledAt),
    status,
    patient: paciente,
  };
}

const ANA_PEREZ = { first_name: 'Ana', last_name: 'Pérez' };

/** ENG-197 — "Mis pacientes" del profesional. */
describe('MyPatientsService', () => {
  let prisma: {
    professional: { findUnique: jest.Mock };
    appointment: { findMany: jest.Mock };
  };
  let service: MyPatientsService;

  beforeEach(() => {
    prisma = {
      professional: {
        findUnique: jest.fn().mockResolvedValue({ profile_id: PRO }),
      },
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new MyPatientsService(prisma as unknown as PrismaService);
  });

  it('lista sus pacientes con última consulta, próximo turno y cantidad', async () => {
    prisma.appointment.findMany.mockResolvedValue([
      turno(JULIAN, '2026-10-01T13:00:00.000Z', 'COMPLETADO'),
      turno(JULIAN, '2026-11-12T13:00:00.000Z', 'COMPLETADO'),
      turno(JULIAN, '2026-12-03T12:30:00.000Z', 'RESERVADO_SIN_PAGAR'),
      turno(JULIAN, '2026-11-20T14:00:00.000Z', 'CONFIRMADO'),
    ]);

    const vista = await service.list(PRO, {}, NOW);

    expect(vista).toMatchObject({ pagina: 1, hayMas: false, total: 1 });
    expect(vista.rows[0]).toEqual({
      patientId: JULIAN,
      firstName: 'Julián',
      lastName: 'Sosa',
      lastConsultation: {
        at: '2026-11-12T13:00:00.000Z',
        date: '2026-11-12',
        startTime: '10:00',
      },
      nextAppointment: {
        at: '2026-11-20T14:00:00.000Z',
        date: '2026-11-20',
        startTime: '11:00',
      },
      consultations: 2,
    });
  });

  it('un turno sin pagar que ya pasó no es el próximo', async () => {
    prisma.appointment.findMany.mockResolvedValue([
      turno(JULIAN, '2026-11-10T13:00:00.000Z', 'RESERVADO_SIN_PAGAR'),
    ]);

    const [fila] = (await service.list(PRO, {}, NOW)).rows;

    expect(fila).toMatchObject({
      lastConsultation: null,
      nextAppointment: null,
      consultations: 0,
    });
  });

  it('solo pide turnos propios en estados que habilitan leer la historia', async () => {
    await service.list(PRO, {}, NOW);

    const [{ where }] = prisma.appointment.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    // Los pacientes de otro profesional no entran: el filtro es por el JWT.
    expect(where).toEqual({
      professional_id: PRO,
      status: { in: ['RESERVADO_SIN_PAGAR', 'CONFIRMADO', 'COMPLETADO'] },
    });
    expect(prisma.professional.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { profile_id: PRO } }),
    );
  });

  it('ordena por última consulta y deja al final a los que no se atendieron, por próximo turno', async () => {
    const BETO = '55555555-5555-4555-8555-555555555555';
    const CARLA = '66666666-6666-4666-8666-666666666666';
    prisma.appointment.findMany.mockResolvedValue([
      turno(BETO, '2026-12-10T13:00:00.000Z', 'CONFIRMADO', {
        first_name: 'Beto',
        last_name: 'Gómez',
      }),
      turno(ANA, '2026-09-01T13:00:00.000Z', 'COMPLETADO', ANA_PEREZ),
      turno(CARLA, '2026-11-25T13:00:00.000Z', 'CONFIRMADO', {
        first_name: 'Carla',
        last_name: 'Díaz',
      }),
      turno(JULIAN, '2026-11-12T13:00:00.000Z', 'COMPLETADO'),
    ]);

    const vista = await service.list(PRO, {}, NOW);

    expect(vista.rows.map((r) => r.patientId)).toEqual([
      JULIAN,
      ANA,
      CARLA,
      BETO,
    ]);
  });

  it('busca por nombre o apellido sin importar mayúsculas ni tildes', async () => {
    prisma.appointment.findMany.mockResolvedValue([
      turno(JULIAN, '2026-11-12T13:00:00.000Z', 'COMPLETADO'),
      turno(ANA, '2026-11-11T13:00:00.000Z', 'COMPLETADO', ANA_PEREZ),
    ]);

    const porNombre = await service.list(PRO, { q: 'JULIAN' }, NOW);
    const porApellido = await service.list(PRO, { q: 'perez' }, NOW);
    const invertido = await service.list(PRO, { q: 'sosa  jul' }, NOW);
    const ninguno = await service.list(PRO, { q: 'zz' }, NOW);

    expect(porNombre.rows.map((r) => r.patientId)).toEqual([JULIAN]);
    expect(porApellido.rows.map((r) => r.patientId)).toEqual([ANA]);
    expect(invertido.rows.map((r) => r.patientId)).toEqual([JULIAN]);
    expect(ninguno).toMatchObject({ rows: [], total: 0, hayMas: false });
  });

  it('pagina de a 20 y dice el total', async () => {
    prisma.appointment.findMany.mockResolvedValue(
      Array.from({ length: MY_PATIENTS_PAGE_SIZE + 3 }, (_, i) =>
        turno(`p${i}`, '2026-11-12T13:00:00.000Z', 'COMPLETADO'),
      ),
    );

    const primera = await service.list(PRO, { pagina: 1 }, NOW);
    const segunda = await service.list(PRO, { pagina: 2 }, NOW);

    expect(primera).toMatchObject({ hayMas: true, total: 23 });
    expect(primera.rows).toHaveLength(MY_PATIENTS_PAGE_SIZE);
    expect(segunda).toMatchObject({ pagina: 2, hayMas: false, total: 23 });
    expect(segunda.rows).toHaveLength(3);
  });

  it('sin fila de profesional, 403 y no consulta turnos', async () => {
    prisma.professional.findUnique.mockResolvedValue(null);

    await expect(service.list(PRO, {}, NOW)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.exportCsv(PRO, {}, NOW)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.appointment.findMany).not.toHaveBeenCalled();
  });

  it('exporta las mismas columnas que la tabla, filtradas por q', async () => {
    prisma.appointment.findMany.mockResolvedValue([
      turno(JULIAN, '2026-11-12T13:00:00.000Z', 'COMPLETADO'),
      turno(JULIAN, '2026-11-20T14:00:00.000Z', 'CONFIRMADO'),
      turno(ANA, '2026-11-11T13:00:00.000Z', 'COMPLETADO', ANA_PEREZ),
    ]);

    const { filename, csv } = await service.exportCsv(
      PRO,
      { q: 'julián' },
      NOW,
    );

    expect(filename).toBe('mis-pacientes-2026-11-14.csv');
    expect(csv).toBe(
      '﻿' +
        'Paciente;Última consulta;Próximo turno;Consultas\r\n' +
        'Julián Sosa;2026-11-12 10:00;2026-11-20 11:00;1\r\n',
    );
  });

  it('el CSV escapa celdas con ; o comillas y deja vacío lo que no hay', () => {
    const csv = toCsv([
      {
        patientId: JULIAN,
        firstName: 'Ana "Anita"',
        lastName: 'Pérez; Gómez',
        lastConsultation: null,
        nextAppointment: null,
        consultations: 0,
      },
    ]);

    expect(csv.split('\r\n')[1]).toBe('"Ana ""Anita"" Pérez; Gómez";;;0');
  });
});
