import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { DailyService } from '../video/daily.service';
import type { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import type { PatientNoticesService } from '../notifications/patient-notices.service';
import { AppointmentClosingService } from './appointment-closing.service';

const APPOINTMENT = '44444444-4444-4444-8444-444444444444';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';

/** Turno de 30 minutos a las 15:00 (UTC). */
const SCHEDULED = new Date('2026-11-20T15:00:00.000Z');
const at = (minutesFromStart: number) =>
  new Date(SCHEDULED.getTime() + minutesFromStart * 60_000);

function appointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT,
    patient_id: PATIENT,
    professional_id: PROFESSIONAL,
    scheduled_at: SCHEDULED.toISOString(),
    duration_minutes: 30,
    status: 'CONFIRMADO',
    created_at: '2026-11-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('AppointmentClosingService', () => {
  let service: AppointmentClosingService;
  let tx: {
    appointment: { update: jest.Mock };
    consultation: { updateMany: jest.Mock };
    videoSession: { updateMany: jest.Mock };
    auditLog: { create: jest.Mock; createMany: jest.Mock };
    $queryRaw: jest.Mock;
  };
  /** Quién entró a la sala. Por defecto los dos: la consulta se hizo. */
  let deleteRoom: jest.Mock;
  let notices: { professionalCancelled: jest.Mock };
  let inApp: { notifyProfessional: jest.Mock };
  let joined: {
    patient_joined_at: Date | null;
    professional_joined_at: Date | null;
  } | null;

  function build(row: unknown, error: unknown = null) {
    const maybeSingle = jest.fn().mockResolvedValue({ data: row, error });
    const supabase = {
      getClientForToken: () => ({
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
      }),
    } as unknown as SupabaseService;

    tx = {
      appointment: { update: jest.fn().mockResolvedValue({}) },
      consultation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      videoSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = {
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
      consultation: { findUnique: jest.fn(() => Promise.resolve(joined)) },
      videoSession: {
        findMany: jest.fn().mockResolvedValue([{ daily_room_name: 'room-1' }]),
      },
    } as unknown as PrismaService;
    deleteRoom = jest.fn().mockResolvedValue(undefined);

    notices = { professionalCancelled: jest.fn().mockResolvedValue(undefined) };
    inApp = { notifyProfessional: jest.fn().mockResolvedValue(undefined) };
    service = new AppointmentClosingService(
      prisma,
      supabase,
      { deleteRoom } as unknown as DailyService,
      notices as unknown as PatientNoticesService,
      inApp as unknown as InAppNotificationsService,
    );
  }

  beforeEach(() => {
    joined = { patient_joined_at: at(1), professional_joined_at: at(0) };
    build(appointmentRow());
  });

  describe('complete', () => {
    it('completa el turno y cierra la consulta y la sesión de video', async () => {
      const result = await service.complete(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        at(25),
      );

      expect(result).toEqual({ id: APPOINTMENT, status: 'COMPLETADO' });
      expect(tx.appointment.update).toHaveBeenCalledWith({
        where: {
          id: APPOINTMENT,
          professional_id: PROFESSIONAL,
          status: 'CONFIRMADO',
        },
        data: { status: 'COMPLETADO', updated_at: at(25) },
      });
      expect(tx.consultation.updateMany).toHaveBeenCalledWith({
        where: { appointment_id: { in: [APPOINTMENT] }, ended_at: null },
        data: { ended_at: at(25) },
      });
      expect(tx.videoSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'FINALIZADA', ended_at: at(25) },
        }),
      );
    });

    it('borra la sala de Daily al finalizar', async () => {
      await service.complete('jwt', PROFESSIONAL, APPOINTMENT, at(25));

      expect(deleteRoom).toHaveBeenCalledWith('room-1');
    });

    it('si Daily falla al borrar la sala, el cierre igual se completa', async () => {
      deleteRoom.mockRejectedValue(new Error('daily caído'));

      await expect(
        service.complete('jwt', PROFESSIONAL, APPOINTMENT, at(25)),
      ).resolves.toEqual({ id: APPOINTMENT, status: 'COMPLETADO' });
    });

    it('queda auditado con el estado anterior', async () => {
      await service.complete('jwt', PROFESSIONAL, APPOINTMENT, at(25));

      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: {
          actor_id: PROFESSIONAL,
          action: 'APPOINTMENT_COMPLETED',
          resource_type: 'appointments',
          resource_id: APPOINTMENT,
          metadata: { previousStatus: 'CONFIRMADO', origin: 'PROFESIONAL' },
        },
      });
    });

    it('es idempotente: un turno ya completado no se vuelve a escribir', async () => {
      build(appointmentRow({ status: 'COMPLETADO' }));

      const result = await service.complete(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        at(25),
      );

      expect(result.status).toBe('COMPLETADO');
      expect(tx.appointment.update).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('da 403 al paciente del turno', async () => {
      await expect(
        service.complete('jwt', PATIENT, APPOINTMENT, at(25)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('da 404 cuando RLS no muestra el turno', async () => {
      build(null);
      await expect(
        service.complete('jwt', PROFESSIONAL, APPOINTMENT, at(25)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('se puede desde que abre la sala, 10 minutos antes', async () => {
      await expect(
        service.complete('jwt', PROFESSIONAL, APPOINTMENT, at(-10)),
      ).resolves.toEqual({ id: APPOINTMENT, status: 'COMPLETADO' });
    });

    it('da 409 antes de que abra la sala', async () => {
      await expect(
        service.complete('jwt', PROFESSIONAL, APPOINTMENT, at(-11)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('da 409 pasadas 24 horas del final', async () => {
      await expect(
        service.complete(
          'jwt',
          PROFESSIONAL,
          APPOINTMENT,
          at(30 + 24 * 60 + 1),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('da 409 con un turno cancelado', async () => {
      build(appointmentRow({ status: 'CANCELADO' }));
      await expect(
        service.complete('jwt', PROFESSIONAL, APPOINTMENT, at(25)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('da 409 si el turno cambió de estado entre la lectura y la escritura', async () => {
      tx.appointment.update.mockRejectedValue({ code: 'P2025' });
      await expect(
        service.complete('jwt', PROFESSIONAL, APPOINTMENT, at(25)),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('quién entró a la sala (review de #113)', () => {
    it('complete da 409 si el profesional no entró', async () => {
      joined = null;
      await expect(
        service.complete('jwt', PROFESSIONAL, APPOINTMENT, at(25)),
      ).rejects.toThrow('Todavía no entraste a la sala de esta consulta.');
      expect(tx.appointment.update).not.toHaveBeenCalled();
    });

    it('complete da 409 si el paciente no entró: corresponde no asistió', async () => {
      joined = { patient_joined_at: null, professional_joined_at: at(0) };
      await expect(
        service.complete('jwt', PROFESSIONAL, APPOINTMENT, at(25)),
      ).rejects.toThrow(/marcalo como no asistió/);
    });

    it('no-show da 409 si el paciente entró a la sala', async () => {
      await expect(
        service.markNoShow('jwt', PROFESSIONAL, APPOINTMENT, at(20)),
      ).rejects.toThrow(
        'El paciente entró a la sala, así que no se puede marcar como no asistió.',
      );
      expect(tx.appointment.update).not.toHaveBeenCalled();
    });

    it('no-show da 409 si el profesional no entró', async () => {
      joined = { patient_joined_at: null, professional_joined_at: null };
      await expect(
        service.markNoShow('jwt', PROFESSIONAL, APPOINTMENT, at(20)),
      ).rejects.toThrow(/No entraste a la sala/);
    });
  });

  describe('markNoShow', () => {
    beforeEach(() => {
      // El caso válido: entró el profesional y el paciente no.
      joined = { patient_joined_at: null, professional_joined_at: at(0) };
    });

    it('deja el turno en NO_ASISTIO sin cerrar la sesión de video', async () => {
      const result = await service.markNoShow(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        at(20),
      );

      expect(result).toEqual({ id: APPOINTMENT, status: 'NO_ASISTIO' });
      expect(tx.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'NO_ASISTIO', updated_at: at(20) },
        }),
      );
      expect(tx.consultation.updateMany).not.toHaveBeenCalled();
      expect(tx.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'APPOINTMENT_NO_SHOW' }),
        }),
      );
    });

    it('da 409 antes de la hora del turno', async () => {
      await expect(
        service.markNoShow('jwt', PROFESSIONAL, APPOINTMENT, at(-1)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('da 403 al paciente', async () => {
      await expect(
        service.markNoShow('jwt', PATIENT, APPOINTMENT, at(20)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('es idempotente', async () => {
      build(appointmentRow({ status: 'NO_ASISTIO' }));
      await service.markNoShow('jwt', PROFESSIONAL, APPOINTMENT, at(20));
      expect(tx.appointment.update).not.toHaveBeenCalled();
    });
  });

  describe('closeFinished (job)', () => {
    it('no escribe nada cuando no hay turnos para cerrar', async () => {
      await expect(service.closeFinished(at(60))).resolves.toEqual([]);
      expect(tx.consultation.updateMany).not.toHaveBeenCalled();
      expect(tx.auditLog.createMany).not.toHaveBeenCalled();
    });

    it('cierra la sesión de los turnos cerrados y audita cada uno como JOB', async () => {
      tx.$queryRaw.mockResolvedValueOnce([
        { id: 'a-1', status: 'COMPLETADO' },
        { id: 'a-2', status: 'NO_ASISTIO' },
      ]);

      const closed = await service.closeFinished(at(60));

      expect(closed).toHaveLength(2);
      expect(tx.consultation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { appointment_id: { in: ['a-1', 'a-2'] }, ended_at: null },
        }),
      );
      expect(tx.auditLog.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            actor_id: null,
            action: 'APPOINTMENT_COMPLETED',
            resource_id: 'a-1',
            metadata: { previousStatus: 'CONFIRMADO', origin: 'JOB' },
          }),
          expect.objectContaining({
            action: 'APPOINTMENT_NO_SHOW',
            resource_id: 'a-2',
          }),
        ],
      });
    });

    it('sin el profesional, el turno queda a reprogramar: reinicia la sala, audita y avisa (ENG-237)', async () => {
      const now = at(60);
      tx.$queryRaw
        .mockResolvedValueOnce([]) // cierre de los que entró el profesional
        .mockResolvedValueOnce([
          { id: 'a-3', patient_joined: true },
          { id: 'a-4', patient_joined: false },
        ]);

      const closed = await service.closeFinished(now);

      expect(closed).toEqual([
        { id: 'a-3', status: 'A_REPROGRAMAR' },
        { id: 'a-4', status: 'A_REPROGRAMAR' },
      ]);
      // La consulta que no se hizo queda sin marcas de asistencia ni sala.
      expect(tx.consultation.updateMany).toHaveBeenCalledWith({
        where: { appointment_id: { in: ['a-3', 'a-4'] } },
        data: {
          patient_joined_at: null,
          professional_joined_at: null,
          ended_at: null,
        },
      });
      expect(tx.auditLog.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            actor_id: null,
            action: 'APPOINTMENT_PROFESSIONAL_NO_SHOW',
            resource_id: 'a-3',
            metadata: expect.objectContaining({
              newStatus: 'A_REPROGRAMAR',
              patientJoined: true,
              reprogramDeadline: new Date(
                now.getTime() + 48 * 3_600_000,
              ).toISOString(),
              origin: 'JOB',
            }),
          }),
          expect.objectContaining({ resource_id: 'a-4' }),
        ],
      });
      expect(notices.professionalCancelled).toHaveBeenCalledWith(
        'a-3',
        'A_REPROGRAMAR',
        now,
      );
      expect(inApp.notifyProfessional).toHaveBeenCalledWith(
        'a-4',
        'TURNO_NO_REALIZADO',
        now,
        { cause: 'AUSENCIA_PROFESIONAL' },
      );
    });
  });

  describe('reportTechnicalFailure (ENG-237, caso 13)', () => {
    const MOTIVO = 'Se cortó la videollamada a los dos minutos.';

    beforeEach(() => build(appointmentRow({ status: 'COMPLETADO' })));

    it('deja el turno a reprogramar con 48 h, reinicia la sala, audita y avisa', async () => {
      const now = at(120);

      const result = await service.reportTechnicalFailure(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        MOTIVO,
        now,
      );

      const deadline = new Date(now.getTime() + 48 * 3_600_000);
      expect(result).toEqual({
        id: APPOINTMENT,
        status: 'A_REPROGRAMAR',
        reprogramDeadline: deadline.toISOString(),
      });
      expect(tx.appointment.update).toHaveBeenCalledWith({
        where: {
          id: APPOINTMENT,
          professional_id: PROFESSIONAL,
          status: 'COMPLETADO',
        },
        data: {
          status: 'A_REPROGRAMAR',
          cancelled_by: 'PROFESIONAL',
          reprogram_cause: 'FALLA_TECNICA',
          cancellation_reason: MOTIVO,
          cancelled_at: now,
          reprogram_deadline: deadline,
          updated_at: now,
        },
      });
      expect(tx.videoSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ daily_room_name: null }),
        }),
      );
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: PROFESSIONAL,
          action: 'APPOINTMENT_TECHNICAL_FAILURE',
          metadata: expect.objectContaining({ reason: MOTIVO }),
        }),
      });
      expect(notices.professionalCancelled).toHaveBeenCalledWith(
        APPOINTMENT,
        'A_REPROGRAMAR',
        now,
      );
    });

    it('se puede hasta 24 h después del final de la consulta', async () => {
      // 15:30 + 24 h.
      await expect(
        service.reportTechnicalFailure(
          'jwt',
          PROFESSIONAL,
          APPOINTMENT,
          MOTIVO,
          at(30 + 24 * 60),
        ),
      ).resolves.toMatchObject({ status: 'A_REPROGRAMAR' });
    });

    it('da 409 pasadas las 24 h', async () => {
      await expect(
        service.reportTechnicalFailure(
          'jwt',
          PROFESSIONAL,
          APPOINTMENT,
          MOTIVO,
          at(31 + 24 * 60),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.appointment.update).not.toHaveBeenCalled();
    });

    it('da 409 si la consulta no está completada', async () => {
      build(appointmentRow({ status: 'NO_ASISTIO' }));
      await expect(
        service.reportTechnicalFailure(
          'jwt',
          PROFESSIONAL,
          APPOINTMENT,
          MOTIVO,
          at(60),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('da 403 al paciente', async () => {
      await expect(
        service.reportTechnicalFailure(
          'jwt',
          PATIENT,
          APPOINTMENT,
          MOTIVO,
          at(60),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('da 409 si el turno cambió entre la lectura y la escritura, y no avisa', async () => {
      tx.appointment.update.mockRejectedValue({ code: 'P2025' });
      await expect(
        service.reportTechnicalFailure(
          'jwt',
          PROFESSIONAL,
          APPOINTMENT,
          MOTIVO,
          at(60),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(notices.professionalCancelled).not.toHaveBeenCalled();
    });
  });
});
