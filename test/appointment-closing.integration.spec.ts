import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma';
import type { DailyService } from '../src/video/daily.service';
import { AppointmentClosingService } from '../src/appointments/appointment-closing.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SupabaseService } from '../src/supabase/supabase.service';

/**
 * ENG-189 — el cierre automático de turnos contra un Postgres real.
 *
 * Es SQL crudo: el `UPDATE … FROM consultations`, el `case` con cast al enum y
 * el `make_interval` con la duración del turno solo se pueden verificar contra
 * la base.
 */
describe('Cierre automático de turnos (integration)', () => {
  const prisma = new PrismaClient();
  const service = new AppointmentClosingService(
    prisma as unknown as PrismaService,
    {} as SupabaseService,
    {} as DailyService,
  );

  const NOW = new Date('2026-11-20T18:00:00.000Z');
  const MINUTE = 60 * 1000;

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
    const appointment = { patient_id: patientId };
    await prisma.videoSession.deleteMany({
      where: { consultation: { appointment } },
    });
    await prisma.consultation.deleteMany({ where: { appointment } });
    await prisma.appointment.deleteMany({ where: appointment });
    await prisma.patient.deleteMany({ where: { profile_id: patientId } });
    await prisma.professional.deleteMany({
      where: { profile_id: professionalId },
    });
    await prisma.profile.deleteMany({ where: { id: { in: profiles } } });
    await prisma.$disconnect();
  });

  /**
   * Turno confirmado de 30 minutos que empezó hace `minutesAgo`, con su
   * consulta y sesión de video si alguien entró.
   */
  async function appointmentWith(
    minutesAgo: number,
    joined: { patient?: boolean; professional?: boolean },
  ) {
    slot += 1;
    const scheduledAt = new Date(
      NOW.getTime() - minutesAgo * MINUTE - slot * 24 * 60 * MINUTE,
    );
    // El `slot` corre cada turno un día para atrás y no choca con el índice
    // único por profesional y horario; los minutos desde el inicio se miden
    // contra un "ahora" corrido el mismo día.
    const appointment = await prisma.appointment.create({
      data: {
        patient_id: patientId,
        professional_id: professionalId,
        scheduled_at: scheduledAt,
        duration_minutes: 30,
        price: 10000,
        status: 'CONFIRMADO',
      },
    });
    if (joined.patient || joined.professional) {
      await prisma.consultation.create({
        data: {
          appointment_id: appointment.id,
          started_at: scheduledAt,
          patient_joined_at: joined.patient ? scheduledAt : null,
          professional_joined_at: joined.professional ? scheduledAt : null,
          video_session: {
            create: { status: 'EN_CURSO', started_at: scheduledAt },
          },
        },
      });
    }
    return {
      id: appointment.id,
      now: new Date(NOW.getTime() - slot * 24 * 60 * MINUTE),
    };
  }

  async function statusOf(id: string) {
    return (await prisma.appointment.findUniqueOrThrow({ where: { id } }))
      .status;
  }

  it('completa el turno al que entraron los dos y cierra la sesión', async () => {
    const turno = await appointmentWith(46, {
      patient: true,
      professional: true,
    });

    const closed = await service.closeFinished(turno.now);

    expect(closed).toContainEqual({ id: turno.id, status: 'COMPLETADO' });
    expect(await statusOf(turno.id)).toBe('COMPLETADO');
    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { appointment_id: turno.id },
      include: { video_session: true },
    });
    expect(consultation.ended_at).toEqual(turno.now);
    expect(consultation.video_session?.status).toBe('FINALIZADA');
  });

  it('marca no asistió si solo entró el profesional', async () => {
    const turno = await appointmentWith(46, { professional: true });

    await service.closeFinished(turno.now);

    expect(await statusOf(turno.id)).toBe('NO_ASISTIO');
  });

  it('no toca el turno al que el profesional no entró', async () => {
    const soloPaciente = await appointmentWith(46, { patient: true });
    await service.closeFinished(soloPaciente.now);
    expect(await statusOf(soloPaciente.id)).toBe('CONFIRMADO');

    const nadie = await appointmentWith(46, {});
    await service.closeFinished(nadie.now);
    expect(await statusOf(nadie.id)).toBe('CONFIRMADO');
  });

  it('no toca un turno cuya sala sigue abierta (30 min + 15 de tolerancia)', async () => {
    const turno = await appointmentWith(44, {
      patient: true,
      professional: true,
    });

    await service.closeFinished(turno.now);

    expect(await statusOf(turno.id)).toBe('CONFIRMADO');
  });

  it('es idempotente: una segunda corrida no vuelve a cerrar ni auditar', async () => {
    const turno = await appointmentWith(46, {
      patient: true,
      professional: true,
    });

    await service.closeFinished(turno.now);
    const second = await service.closeFinished(turno.now);

    expect(second.map((c) => c.id)).not.toContain(turno.id);
    const audits = await prisma.auditLog.count({
      where: { resource_id: turno.id, action: 'APPOINTMENT_COMPLETED' },
    });
    expect(audits).toBe(1);
  });
});
