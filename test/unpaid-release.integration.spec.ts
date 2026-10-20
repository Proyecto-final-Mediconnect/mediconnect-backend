import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma';
import { UnpaidReleaseService } from '../src/appointments/unpaid-release.service';
import type { AppointmentPaymentService } from '../src/payments/appointment-payment.service';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * ENG-101 — el `UPDATE … RETURNING` de la liberación contra un Postgres real.
 *
 * Es SQL crudo: los casts de los enums, los parámetros uuid/timestamptz y el
 * `not exists` sobre `payments` solo se pueden verificar contra la base.
 */
describe('Liberación de turnos impagos (integration)', () => {
  const prisma = new PrismaClient();
  const expireCheckout = jest.fn().mockResolvedValue(undefined);
  const service = new UnpaidReleaseService(
    prisma as unknown as PrismaService,
    { expireCheckout } as unknown as AppointmentPaymentService,
  );

  const NOW = new Date('2026-10-14T12:00:00.000Z');
  const MINUTE = 60 * 1000;
  const TOMORROW = new Date(NOW.getTime() + 24 * 60 * MINUTE);

  const profiles: string[] = [];
  let patientId: string;
  let professionalId: string;
  let slot = 0;

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
        first_name: 'Test',
        last_name: 'Paciente',
      },
    });
    await prisma.professional.create({
      data: {
        profile_id: professionalId,
        first_name: 'Test',
        last_name: 'Profesional',
        license_number: `MP-${professionalId.slice(0, 8)}`,
      },
    });
  });

  afterAll(async () => {
    const where = { patient_id: patientId };
    await prisma.payment.deleteMany({ where: { appointment: where } });
    await prisma.appointment.deleteMany({ where });
    await prisma.patient.deleteMany({ where: { profile_id: patientId } });
    await prisma.professional.deleteMany({
      where: { profile_id: professionalId },
    });
    await prisma.profile.deleteMany({ where: { id: { in: profiles } } });
    await prisma.$disconnect();
  });

  beforeEach(() => expireCheckout.mockClear());

  /** Turno reservado hace `minutesAgo`, en un horario propio para no chocar
   *  con el índice único por profesional y horario. */
  async function reserve(
    minutesAgo: number,
    overrides: {
      status?: 'RESERVADO_SIN_PAGAR' | 'CONFIRMADO';
      scheduledAt?: Date;
    } = {},
  ) {
    slot += 1;
    const appointment = await prisma.appointment.create({
      data: {
        patient_id: patientId,
        professional_id: professionalId,
        scheduled_at:
          overrides.scheduledAt ??
          new Date(TOMORROW.getTime() + slot * 60 * MINUTE),
        duration_minutes: 30,
        price: 10000,
        status: overrides.status ?? 'RESERVADO_SIN_PAGAR',
        created_at: new Date(NOW.getTime() - minutesAgo * MINUTE),
      },
    });
    return appointment.id;
  }

  async function statusOf(id: string) {
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id } });
    return row.status;
  }

  it('libera la retención de 15 minutos y deja la de 14', async () => {
    const vencida = await reserve(15);
    const vigente = await reserve(14);

    const released = await service.releaseExpired(NOW, { patientId });

    expect(released).toEqual([vencida]);
    expect(await statusOf(vencida)).toBe('LIBERADO');
    expect(await statusOf(vigente)).toBe('RESERVADO_SIN_PAGAR');
    expect(expireCheckout).toHaveBeenCalledWith(vencida, NOW);
  });

  it('no toca un turno confirmado', async () => {
    const confirmado = await reserve(60, { status: 'CONFIRMADO' });

    await service.releaseExpired(NOW, { patientId });

    expect(await statusOf(confirmado)).toBe('CONFIRMADO');
  });

  it('no libera un turno con el pago APROBADO aunque el webhook no lo haya confirmado', async () => {
    const pagando = await reserve(60);
    await prisma.payment.create({
      data: { appointment_id: pagando, amount: 10000, status: 'APROBADO' },
    });

    await service.releaseExpired(NOW, { patientId });

    expect(await statusOf(pagando)).toBe('RESERVADO_SIN_PAGAR');
  });

  it('sí libera uno con el pago RECHAZADO', async () => {
    const rechazado = await reserve(60);
    await prisma.payment.create({
      data: { appointment_id: rechazado, amount: 10000, status: 'RECHAZADO' },
    });

    await service.releaseExpired(NOW, { patientId });

    expect(await statusOf(rechazado)).toBe('LIBERADO');
  });

  it('no libera un turno que ya empezó: puede haber sido atendido', async () => {
    const pasado = await reserve(24 * 60, {
      scheduledAt: new Date(NOW.getTime() - 60 * MINUTE),
    });

    await service.releaseExpired(NOW, { patientId });

    expect(await statusOf(pasado)).toBe('RESERVADO_SIN_PAGAR');
  });

  it('el scope por profesional no libera turnos de otros profesionales', async () => {
    const vencida = await reserve(30);

    const released = await service.releaseExpired(NOW, {
      professionalId: randomUUID(),
    });

    expect(released).not.toContain(vencida);
    expect(await statusOf(vencida)).toBe('RESERVADO_SIN_PAGAR');
  });

  it('una segunda corrida no vuelve a liberar ni a tocar MercadoPago', async () => {
    await reserve(30);
    await service.releaseExpired(NOW, { patientId });
    expireCheckout.mockClear();

    const released = await service.releaseExpired(NOW, { patientId });

    expect(released).toEqual([]);
    expect(expireCheckout).not.toHaveBeenCalled();
  });
});
