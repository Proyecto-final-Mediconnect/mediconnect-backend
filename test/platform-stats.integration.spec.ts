import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma';
import { PlatformStatsService } from '../src/admin/platform-stats.service';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * El panel de plataforma (ENG-195) contra Postgres de verdad. Se siembra un
 * período aislado (marzo y abril de 2031, donde no hay otros datos) para
 * comprobar los números exactos: el agrupado por mes en hora de Argentina, las
 * sumas de cobros y reembolsos, y que los turnos fuera del período no cuentan.
 */
describe('Panel de plataforma (integration)', () => {
  const prisma = new PrismaClient();
  const service = new PlatformStatsService(prisma as unknown as PrismaService);

  const proId: string = randomUUID();
  const patientId: string = randomUUID();
  /** 31/03/2031 a las 23:30 en Argentina = 01/04 a las 02:30 UTC. */
  const FIN_DE_MARZO = new Date('2031-04-01T02:30:00.000Z');
  const ABRIL = new Date('2031-04-10T13:00:00.000Z');
  const FUERA = new Date('2031-06-10T13:00:00.000Z');
  let integrityId = '';

  async function turno(
    status: 'COMPLETADO' | 'CANCELADO' | 'CONFIRMADO',
    at: Date,
  ) {
    return prisma.appointment.create({
      data: {
        patient_id: patientId,
        professional_id: proId,
        scheduled_at: at,
        duration_minutes: 30,
        price: 10000,
        status,
      },
    });
  }

  beforeAll(async () => {
    await prisma.profile.createMany({
      data: [
        { id: proId, email: `pro-${proId}@test.local`, role: 'PROFESIONAL' },
        { id: patientId, email: `p-${patientId}@test.local`, role: 'PACIENTE' },
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
        profile_id: proId,
        first_name: 'Test',
        last_name: 'Plataforma',
        license_number: `MP-${proId.slice(0, 8)}`,
        status: 'VALIDADO',
      },
    });

    const marzo = await turno('COMPLETADO', FIN_DE_MARZO);
    await turno('COMPLETADO', ABRIL);
    const cancelado = await turno('CANCELADO', ABRIL);
    await turno('CONFIRMADO', FUERA);

    await prisma.payment.create({
      data: {
        appointment_id: marzo.id,
        amount: 10000,
        status: 'APROBADO',
        confirmed_at: FIN_DE_MARZO,
      },
    });
    const pagoCancelado = await prisma.payment.create({
      data: {
        appointment_id: cancelado.id,
        amount: 12000,
        status: 'APROBADO',
        confirmed_at: new Date('2031-04-02T13:00:00.000Z'),
      },
    });
    await prisma.refund.create({
      data: {
        payment_id: pagoCancelado.id,
        amount: 6000,
        status: 'PROCESADO',
        processed_at: new Date('2031-04-05T13:00:00.000Z'),
      },
    });
    await prisma.review.create({
      data: {
        patient_id: patientId,
        professional_id: proId,
        appointment_id: marzo.id,
        rating: 4,
        status: 'APROBADA',
        created_at: ABRIL,
      },
    });
    const check = await prisma.integrityCheck.create({
      data: {
        status: 'OK',
        inconsistencies_found: 0,
        details: { patients_checked: 12, entries_checked: 340 },
        // En el futuro, para ser la última corrida mientras dura el test.
        run_at: new Date('2031-04-20T03:00:00.000Z'),
      },
    });
    integrityId = check.id;
  });

  afterAll(async () => {
    await prisma.integrityCheck.deleteMany({ where: { id: integrityId } });
    await prisma.review.deleteMany({ where: { professional_id: proId } });
    await prisma.refund.deleteMany({
      where: { payment: { appointment: { professional_id: proId } } },
    });
    await prisma.payment.deleteMany({
      where: { appointment: { professional_id: proId } },
    });
    await prisma.appointment.deleteMany({ where: { professional_id: proId } });
    await prisma.patient.deleteMany({ where: { profile_id: patientId } });
    await prisma.professional.deleteMany({ where: { profile_id: proId } });
    await prisma.profile.deleteMany({
      where: { id: { in: [proId, patientId] } },
    });
    await prisma.$disconnect();
  });

  it('cuenta el período exacto, agrupa por mes en hora de Argentina y suma la plata', async () => {
    const stats = await service.get({ from: '2031-03-01', to: '2031-04-30' });

    expect(stats.turnos).toMatchObject({
      total: 3,
      completados: 2,
      cancelados: 1,
      pendientes: 0,
    });
    // El del 31/03 a las 23:30 es de marzo, aunque en UTC ya sea abril.
    expect(stats.turnos.porMes).toEqual([
      { mes: '2031-03', turnos: 1, completados: 1 },
      { mes: '2031-04', turnos: 2, completados: 1 },
    ]);
    expect(stats.cobros).toEqual({
      moneda: 'ARS',
      cobrado: 22000,
      reembolsado: 6000,
      neto: 16000,
      pagos: 2,
    });
    expect(stats.resenas).toEqual({ cantidad: 1, promedio: 4 });
    expect(stats.integridad).toEqual({
      at: '2031-04-20T03:00:00.000Z',
      status: 'OK',
      inconsistencies: 0,
      patientsChecked: 12,
      entriesChecked: 340,
    });
    // Los totales de usuarios y profesionales son de hoy, no del período.
    expect(stats.usuarios.pacientes).toBeGreaterThanOrEqual(1);
    expect(stats.profesionales.validados).toBeGreaterThanOrEqual(1);
  });

  it('un período sin datos da ceros, con los meses en 0', async () => {
    const stats = await service.get({ from: '2031-08-01', to: '2031-09-30' });

    expect(stats.turnos.total).toBe(0);
    expect(stats.turnos.porMes).toEqual([
      { mes: '2031-08', turnos: 0, completados: 0 },
      { mes: '2031-09', turnos: 0, completados: 0 },
    ]);
    expect(stats.cobros.neto).toBe(0);
    expect(stats.resenas.promedio).toBeNull();
  });

  it('no devuelve nada que identifique a una persona', async () => {
    const stats = await service.get({ from: '2031-03-01', to: '2031-04-30' });
    const texto = JSON.stringify(stats);

    expect(texto).not.toContain(patientId);
    expect(texto).not.toContain(proId);
    expect(texto).not.toContain('@test.local');
    expect(texto).not.toContain('Paciente');
  });
});
