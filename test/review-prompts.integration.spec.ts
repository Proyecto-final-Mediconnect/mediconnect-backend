import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ReviewPromptsService } from '../src/reviews/review-prompts.service';

/**
 * ENG-190 — reseñas pendientes y descarte contra un Postgres real: la tabla
 * `review_prompt_dismissals` de la migración, el filtro por la consulta
 * (`patient_joined_at`) y que el descarte no se duplique.
 */
describe('Pedido de reseña (integration)', () => {
  const prisma = new PrismaClient();
  const service = new ReviewPromptsService(prisma as unknown as PrismaService);

  const NOW = new Date('2026-11-20T18:00:00.000Z');
  const HOUR = 60 * 60 * 1000;

  let patientId: string;
  let professionalId: string;
  let slot = 0;

  beforeAll(async () => {
    patientId = randomUUID();
    professionalId = randomUUID();
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
        first_name: 'Ana',
        last_name: 'Gómez',
        license_number: `MP-${professionalId.slice(0, 8)}`,
      },
    });
  });

  afterAll(async () => {
    const appointment = { patient_id: patientId };
    await prisma.reviewPromptDismissal.deleteMany({ where: { appointment } });
    await prisma.consultation.deleteMany({ where: { appointment } });
    await prisma.appointment.deleteMany({ where: appointment });
    await prisma.patient.deleteMany({ where: { profile_id: patientId } });
    await prisma.professional.deleteMany({
      where: { profile_id: professionalId },
    });
    await prisma.profile.deleteMany({
      where: { id: { in: [patientId, professionalId] } },
    });
    await prisma.$disconnect();
  });

  async function turno(
    status: 'CONFIRMADO' | 'COMPLETADO' | 'NO_ASISTIO',
    patientJoined: boolean,
  ) {
    slot += 1;
    const scheduledAt = new Date(NOW.getTime() - slot * HOUR);
    const row = await prisma.appointment.create({
      data: {
        patient_id: patientId,
        professional_id: professionalId,
        scheduled_at: scheduledAt,
        duration_minutes: 30,
        price: 10000,
        status,
      },
    });
    if (patientJoined) {
      await prisma.consultation.create({
        data: { appointment_id: row.id, patient_joined_at: scheduledAt },
      });
    }
    return row.id;
  }

  it('lista los completados y los confirmados a los que el paciente entró', async () => {
    const completado = await turno('COMPLETADO', false);
    const entro = await turno('CONFIRMADO', true);
    const noEntro = await turno('CONFIRMADO', false);
    const noAsistio = await turno('NO_ASISTIO', true);

    const ids = (await service.listPending(patientId, NOW)).map(
      (p) => p.appointmentId,
    );

    expect(ids).toEqual(expect.arrayContaining([completado, entro]));
    expect(ids).not.toContain(noEntro);
    expect(ids).not.toContain(noAsistio);
  });

  it('el descarte lo saca de la lista y repetirlo no falla', async () => {
    const id = await turno('COMPLETADO', false);

    await service.dismiss(patientId, id);
    await service.dismiss(patientId, id);

    const ids = (await service.listPending(patientId, NOW)).map(
      (p) => p.appointmentId,
    );
    expect(ids).not.toContain(id);
    expect(
      await prisma.reviewPromptDismissal.count({
        where: { appointment_id: id },
      }),
    ).toBe(1);
  });
});
