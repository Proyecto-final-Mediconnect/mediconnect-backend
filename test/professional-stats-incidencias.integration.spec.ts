import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma';
import { ProfessionalStatsService } from '../src/professionals/professional-stats.service';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * ENG-237 (ADR-018, caso 9) — las cancelaciones, ausencias y fallas del
 * profesional en "Mi actividad", contra un Postgres real: el `join` de
 * `audit_logs` con `appointments` es SQL a mano.
 */
describe('Mi actividad: incidencias del profesional (integration)', () => {
  const prisma = new PrismaClient();
  const service = new ProfessionalStatsService(
    prisma as unknown as PrismaService,
  );
  const patientId = randomUUID();
  const professionalId = randomUUID();
  const otherId = randomUUID();
  const NOW = new Date();

  async function turno(pro: string, dias: number) {
    const a = await prisma.appointment.create({
      data: {
        patient_id: patientId,
        professional_id: pro,
        scheduled_at: new Date(NOW.getTime() - dias * 86_400_000),
        duration_minutes: 30,
        price: 10000,
        status: 'COMPLETADO',
      },
    });
    return a.id;
  }

  /** `audit_logs` fija `created_at` al insertar: el evento es de hoy. */
  async function evento(id: string, action: string) {
    await prisma.auditLog.create({
      data: { action, resource_type: 'appointments', resource_id: id },
    });
  }

  beforeAll(async () => {
    await prisma.profile.createMany({
      data: [
        { id: patientId, email: `p-${patientId}@test.local`, role: 'PACIENTE' },
        ...[professionalId, otherId].map((id) => ({
          id,
          email: `pro-${id}@test.local`,
          role: 'PROFESIONAL' as const,
        })),
      ],
    });
    await prisma.patient.create({
      data: {
        profile_id: patientId,
        first_name: 'Test',
        last_name: 'Paciente',
      },
    });
    for (const id of [professionalId, otherId]) {
      await prisma.professional.create({
        data: {
          profile_id: id,
          first_name: 'Test',
          last_name: 'Profesional',
          license_number: `MP-${id.slice(0, 8)}`,
        },
      });
    }
  });

  afterAll(async () => {
    const ids = (
      await prisma.appointment.findMany({
        where: { patient_id: patientId },
        select: { id: true },
      })
    ).map((a) => a.id);
    await prisma.auditLog.deleteMany({ where: { resource_id: { in: ids } } });
    await prisma.appointment.deleteMany({ where: { patient_id: patientId } });
    await prisma.patient.deleteMany({ where: { profile_id: patientId } });
    await prisma.professional.deleteMany({
      where: { profile_id: { in: [professionalId, otherId] } },
    });
    await prisma.profile.deleteMany({
      where: { id: { in: [patientId, professionalId, otherId] } },
    });
    await prisma.$disconnect();
  });

  it('cuenta las del profesional en el período, y no las de otro ni las de antes', async () => {
    const a1 = await turno(professionalId, 1);
    const a2 = await turno(professionalId, 2);
    const a3 = await turno(professionalId, 3);
    const deOtro = await turno(otherId, 1);
    await evento(a1, 'APPOINTMENT_CANCELLED_BY_PROFESSIONAL');
    await evento(a2, 'APPOINTMENT_PROFESSIONAL_NO_SHOW');
    await evento(a3, 'APPOINTMENT_TECHNICAL_FAILURE');
    // Una ausencia del mismo turno, reprogramado, que vuelve a pasar.
    await evento(a2, 'APPOINTMENT_PROFESSIONAL_NO_SHOW');
    // De otro profesional: no cuenta.
    await evento(deOtro, 'APPOINTMENT_PROFESSIONAL_NO_SHOW');

    const stats = await service.get(professionalId, {});
    expect(stats.incidencias).toEqual({
      cancelaciones: 1,
      ausencias: 2,
      fallasTecnicas: 1,
    });

    // Un período que no incluye hoy no las cuenta: van por fecha del hecho.
    const enero = await service.get(professionalId, {
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(enero.incidencias).toEqual({
      cancelaciones: 0,
      ausencias: 0,
      fallasTecnicas: 0,
    });
  });
});
