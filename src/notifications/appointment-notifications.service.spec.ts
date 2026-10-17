import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentNotificationsService } from './appointment-notifications.service';
import { EmailDeliveryError, EmailService } from './email.service';

/**
 * ENG-68 — reclamo, envío y reintento de los emails de turno.
 *
 * Qué turnos entran en cada ventana lo cubre
 * `test/appointment-notifications.integration.spec.ts` contra un Postgres real.
 */

const NOW = new Date('2026-10-14T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const APPOINTMENT = {
  id: 'turno-1',
  patient_id: 'paciente-1',
  scheduled_at: new Date(NOW.getTime() + 48 * HOUR),
  duration_minutes: 30,
  created_at: new Date(NOW.getTime() - HOUR),
  patient: { first_name: 'Juan', profile: { email: 'juan@test.local' } },
  professional: { first_name: 'Ana', last_name: 'Gómez' },
};

describe('AppointmentNotificationsService', () => {
  let prisma: {
    appointment: { findMany: jest.Mock; findFirst: jest.Mock };
    notification: { create: jest.Mock; update: jest.Mock; delete: jest.Mock };
  };
  let email: { isConfigured: jest.Mock; send: jest.Mock };
  let service: AppointmentNotificationsService;

  beforeEach(() => {
    prisma = {
      appointment: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(APPOINTMENT),
      },
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'notif-1' }),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    email = {
      isConfigured: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue('email-1'),
    };
    service = new AppointmentNotificationsService(
      prisma as unknown as PrismaService,
      email as unknown as EmailService,
      { get: () => 'https://app.test' } as unknown as ConfigService,
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('sendConfirmation', () => {
    it('reclama el envío, manda al paciente y marca sent_at', async () => {
      await service.sendConfirmation('turno-1', NOW);

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          user_id: 'paciente-1',
          appointment_id: 'turno-1',
          type: 'TURNO_RESERVADO',
          channel: 'EMAIL',
        },
        select: { id: true },
      });
      expect(email.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'juan@test.local',
          subject: 'Tu turno con Ana Gómez está confirmado',
          idempotencyKey: 'turno-1:TURNO_RESERVADO',
        }),
      );
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'notif-1' },
        data: { sent_at: NOW },
      });
    });

    it('si otro proceso ya lo reclamó, no manda', async () => {
      // El webhook y el job llegaron juntos: el índice único deja insertar a uno.
      prisma.notification.create.mockRejectedValue({ code: 'P2002' });

      await service.sendConfirmation('turno-1', NOW);

      expect(email.send).not.toHaveBeenCalled();
    });

    it('una falla transitoria libera el reclamo para que el job reintente', async () => {
      email.send.mockRejectedValue(new EmailDeliveryError('503', false));

      await service.sendConfirmation('turno-1', NOW);

      expect(prisma.notification.delete).toHaveBeenCalledWith({
        where: { id: 'notif-1' },
      });
    });

    it('una falla permanente deja el error registrado y no se reintenta', async () => {
      email.send.mockRejectedValue(
        new EmailDeliveryError('422 inválido', true),
      );

      await service.sendConfirmation('turno-1', NOW);

      expect(prisma.notification.delete).not.toHaveBeenCalled();
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'notif-1' },
        data: { payload: { error: expect.stringContaining('422') } },
      });
    });

    it('nunca tira: el turno ya quedó confirmado', async () => {
      prisma.appointment.findFirst.mockRejectedValue(new Error('db caída'));

      await expect(
        service.sendConfirmation('turno-1', NOW),
      ).resolves.toBeUndefined();
    });

    it('sin email configurado no reclama nada', async () => {
      email.isConfigured.mockReturnValue(false);

      await service.sendConfirmation('turno-1', NOW);

      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('el registro no guarda el email del paciente', async () => {
      email.send.mockRejectedValue(new EmailDeliveryError('422', true));

      await service.sendConfirmation('turno-1', NOW);

      const calls = JSON.stringify([
        prisma.notification.create.mock.calls,
        prisma.notification.update.mock.calls,
      ]);
      expect(calls).not.toContain('juan@test.local');
    });
  });

  describe('sendDue', () => {
    it('sin email configurado no consulta ni manda nada', async () => {
      email.isConfigured.mockReturnValue(false);

      await expect(service.sendDue(NOW)).resolves.toEqual({
        enabled: false,
        sent: 0,
        failed: 0,
      });
      expect(prisma.appointment.findMany).not.toHaveBeenCalled();
    });

    it('cuenta enviados y fallidos', async () => {
      prisma.appointment.findMany
        .mockResolvedValueOnce([APPOINTMENT]) // confirmaciones
        .mockResolvedValueOnce([]) // 24 h
        .mockResolvedValueOnce([
          {
            ...APPOINTMENT,
            id: 'turno-2',
            scheduled_at: new Date(NOW.getTime() + 30 * 60 * 1000),
            created_at: new Date(NOW.getTime() - 48 * HOUR),
          },
        ]); // 1 h
      email.send
        .mockResolvedValueOnce('email-1')
        .mockRejectedValueOnce(new EmailDeliveryError('500', false));

      await expect(service.sendDue(NOW)).resolves.toEqual({
        enabled: true,
        sent: 1,
        failed: 1,
      });
    });
  });
});
