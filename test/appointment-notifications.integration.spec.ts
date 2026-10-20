import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma';
import { AppointmentNotificationsService } from '../src/notifications/appointment-notifications.service';
import {
  EmailDeliveryError,
  type EmailService,
} from '../src/notifications/email.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * ENG-68 — qué turnos reciben cada email, contra un Postgres real.
 *
 * Cubre los filtros por relación (`notifications: { none }`), las ventanas de
 * tiempo y la unicidad que impide mandar dos veces.
 */
describe('Emails de turno (integration)', () => {
  const prisma = new PrismaClient();
  const send = jest.fn().mockResolvedValue('email-id');
  const service = new AppointmentNotificationsService(
    prisma as unknown as PrismaService,
    { isConfigured: () => true, send } as unknown as EmailService,
    { get: () => 'https://app.test' } as unknown as ConfigService,
  );

  const NOW = new Date('2026-10-14T12:00:00.000Z');
  const HOUR = 60 * 60 * 1000;

  const profiles: string[] = [];
  let patientId: string;
  let professionalId: string;

  beforeAll(async () => {
    patientId = randomUUID();
    professionalId = randomUUID();
    profiles.push(patientId, professionalId);
    await prisma.profile.createMany({
      data: [
        { id: patientId, email: `p-${patientId}@test.local`, role: 'PACIENTE' },
        {
          id: professionalId,
          email: `pro-${professionalId}@test.local`,
          role: 'PROFESIONAL',
        },
      ],
    });
    await prisma.patient.create({
      data: {
        profile_id: patientId,
        first_name: 'Juan',
        last_name: 'Paciente',
      },
    });
    await prisma.professional.create({
      data: {
        profile_id: professionalId,
        first_name: 'Ana',
        last_name: 'Gómez',
        license_number: `MP-${professionalId.slice(0, 8)}`,
      },
    });
  });

  // Cada test arranca sin turnos: las ventanas se pisarían entre casos.
  beforeEach(async () => {
    send.mockClear();
    await prisma.appointment.deleteMany({ where: { patient_id: patientId } });
  });

  afterAll(async () => {
    await prisma.appointment.deleteMany({ where: { patient_id: patientId } });
    await prisma.patient.deleteMany({ where: { profile_id: patientId } });
    await prisma.professional.deleteMany({
      where: { profile_id: professionalId },
    });
    await prisma.profile.deleteMany({ where: { id: { in: profiles } } });
    await prisma.$disconnect();
  });

  async function appointment(opts: {
    startsIn: number;
    createdAgo: number;
    confirmedAgo?: number;
    status?: 'CONFIRMADO' | 'RESERVADO_SIN_PAGAR' | 'CANCELADO';
  }) {
    const row = await prisma.appointment.create({
      data: {
        patient_id: patientId,
        professional_id: professionalId,
        scheduled_at: new Date(NOW.getTime() + opts.startsIn),
        duration_minutes: 30,
        price: 10000,
        status: opts.status ?? 'CONFIRMADO',
        created_at: new Date(NOW.getTime() - opts.createdAgo),
        updated_at: new Date(
          NOW.getTime() - (opts.confirmedAgo ?? opts.createdAgo),
        ),
      },
    });
    return row.id;
  }

  async function sentKinds(appointmentId: string) {
    const rows = await prisma.notification.findMany({
      where: { appointment_id: appointmentId, sent_at: { not: null } },
      select: { type: true },
    });
    return rows.map((r) => r.type).sort();
  }

  it('confirma un turno confirmado recién, y una sola vez', async () => {
    const id = await appointment({
      startsIn: 72 * HOUR,
      createdAgo: HOUR,
      confirmedAgo: 0,
    });

    await service.sendDue(NOW);
    await service.sendDue(NOW);

    expect(await sentKinds(id)).toEqual(['TURNO_RESERVADO']);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('no confirma turnos confirmados hace más de 24 h (los de antes del deploy)', async () => {
    const id = await appointment({
      startsIn: 72 * HOUR,
      createdAgo: 30 * HOUR,
    });

    await service.sendDue(NOW);

    expect(await sentKinds(id)).toEqual([]);
  });

  it('no manda nada por turnos sin pagar o cancelados', async () => {
    const sinPagar = await appointment({
      startsIn: 2 * HOUR,
      createdAgo: 48 * HOUR,
      confirmedAgo: 0,
      status: 'RESERVADO_SIN_PAGAR',
    });
    const cancelado = await appointment({
      startsIn: 3 * HOUR,
      createdAgo: 48 * HOUR,
      confirmedAgo: 0,
      status: 'CANCELADO',
    });

    await service.sendDue(NOW);

    expect(await sentKinds(sinPagar)).toEqual([]);
    expect(await sentKinds(cancelado)).toEqual([]);
  });

  it('recordatorio de 24 h a un turno reservado con anticipación', async () => {
    const id = await appointment({
      startsIn: 20 * HOUR,
      createdAgo: 48 * HOUR,
    });

    await service.sendDue(NOW);

    expect(await sentKinds(id)).toEqual(['RECORDATORIO_24H']);
  });

  it('sin recordatorio de 24 h si se reservó con menos de 24 h de anticipación', async () => {
    // Reservado hace 2 h para dentro de 20: la confirmación acaba de salir.
    const id = await appointment({ startsIn: 20 * HOUR, createdAgo: 2 * HOUR });

    await service.sendDue(NOW);

    expect(await sentKinds(id)).not.toContain('RECORDATORIO_24H');
  });

  it('a menos de 1 h manda el de 1 h, no el de 24 h atrasado', async () => {
    const id = await appointment({
      startsIn: 0.5 * HOUR,
      createdAgo: 48 * HOUR,
    });

    await service.sendDue(NOW);

    expect(await sentKinds(id)).toEqual(['RECORDATORIO_1H']);
  });

  it('el de 24 h y el de 1 h salen en su momento, cada uno una vez', async () => {
    const id = await appointment({
      startsIn: 23 * HOUR,
      createdAgo: 48 * HOUR,
    });

    await service.sendDue(NOW);
    await service.sendDue(new Date(NOW.getTime() + 22.5 * HOUR));
    await service.sendDue(new Date(NOW.getTime() + 22.6 * HOUR));

    expect(await sentKinds(id)).toEqual([
      'RECORDATORIO_1H',
      'RECORDATORIO_24H',
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('un fallo transitorio se reintenta en la corrida siguiente', async () => {
    const id = await appointment({
      startsIn: 20 * HOUR,
      createdAgo: 48 * HOUR,
    });
    send.mockRejectedValueOnce(new EmailDeliveryError('503', false));

    await service.sendDue(NOW);
    expect(await sentKinds(id)).toEqual([]);

    await service.sendDue(NOW);
    expect(await sentKinds(id)).toEqual(['RECORDATORIO_24H']);
  });

  it('la unicidad impide dos registros del mismo aviso', async () => {
    const id = await appointment({ startsIn: 72 * HOUR, createdAgo: HOUR });
    const data = {
      user_id: patientId,
      appointment_id: id,
      type: 'TURNO_RESERVADO' as const,
      channel: 'EMAIL' as const,
    };
    await prisma.notification.create({ data });

    await expect(prisma.notification.create({ data })).rejects.toMatchObject({
      code: 'P2002',
    });
  });
});
