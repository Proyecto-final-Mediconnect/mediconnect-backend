import { Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InAppNotificationsService } from './in-app-notifications.service';

/** ENG-69 — la bandeja de avisos in-app y los avisos al profesional. */

const NOW = new Date('2026-10-21T15:00:00.000Z');
const APPOINTMENT_ID = 'turno-1';
const PRO_ID = 'pro-1';
const USER_ID = 'user-1';

const APPOINTMENT = {
  professional_id: PRO_ID,
  scheduled_at: new Date('2026-10-23T13:30:00.000Z'), // viernes 10:30 en AR
  patient: { first_name: 'Julián', last_name: 'Pérez' },
};

describe('InAppNotificationsService', () => {
  let prisma: {
    appointment: { findUnique: jest.Mock };
    notification: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let service: InAppNotificationsService;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      appointment: { findUnique: jest.fn().mockResolvedValue(APPOINTMENT) },
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'n-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new InAppNotificationsService(prisma as unknown as PrismaService);
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('notifyProfessional', () => {
    it('deja el aviso en la bandeja del profesional del turno', async () => {
      await service.notifyProfessional(APPOINTMENT_ID, 'PAGO_CONFIRMADO', NOW);

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          user_id: PRO_ID,
          appointment_id: APPOINTMENT_ID,
          type: 'PAGO_CONFIRMADO',
          channel: 'IN_APP',
          payload: {
            appointmentId: APPOINTMENT_ID,
            patient: 'Julián Pérez',
            scheduledAt: '2026-10-23T13:30:00.000Z',
          },
          sent_at: NOW,
        },
      });
    });

    it('un aviso repetido (webhook duplicado) no es un error', async () => {
      prisma.notification.create.mockRejectedValue({ code: 'P2002' });

      await expect(
        service.notifyProfessional(APPOINTMENT_ID, 'PAGO_CONFIRMADO', NOW),
      ).resolves.toBeUndefined();
      expect(logError).not.toHaveBeenCalled();
    });

    it('nunca tira: si la base falla, lo loguea y sigue', async () => {
      prisma.notification.create.mockRejectedValue(new Error('db caída'));

      await expect(
        service.notifyProfessional(APPOINTMENT_ID, 'TURNO_CANCELADO', NOW),
      ).resolves.toBeUndefined();
      expect(logError).toHaveBeenCalled();
    });

    it('sin turno no deja nada', async () => {
      prisma.appointment.findUnique.mockResolvedValue(null);

      await service.notifyProfessional(APPOINTMENT_ID, 'PAGO_CONFIRMADO', NOW);

      expect(prisma.notification.create).not.toHaveBeenCalled();
    });
  });

  describe('listMine', () => {
    it('devuelve los avisos in-app propios con su texto y el contador de no leídos', async () => {
      prisma.notification.findMany.mockResolvedValue([
        {
          id: 'n-1',
          type: 'PAGO_CONFIRMADO',
          payload: {
            appointmentId: APPOINTMENT_ID,
            patient: 'Julián Pérez',
            scheduledAt: '2026-10-23T13:30:00.000Z',
          },
          appointment_id: APPOINTMENT_ID,
          created_at: NOW,
          read_at: null,
        },
      ]);
      prisma.notification.count.mockResolvedValue(1);

      const inbox = await service.listMine(USER_ID);

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: USER_ID, channel: 'IN_APP' },
          orderBy: { created_at: 'desc' },
        }),
      );
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { user_id: USER_ID, channel: 'IN_APP', read_at: null },
      });
      expect(inbox).toEqual({
        unreadCount: 1,
        notifications: [
          {
            id: 'n-1',
            type: 'PAGO_CONFIRMADO',
            appointmentId: APPOINTMENT_ID,
            createdAt: NOW.toISOString(),
            readAt: null,
            title: 'Turno nuevo confirmado',
            body: 'Julián Pérez reservó y pagó un turno para el viernes, 23 de octubre a las 10:30.',
          },
        ],
      });
    });
  });

  describe('markRead', () => {
    it('marca como leído solo un aviso propio y sin leer', async () => {
      await service.markRead(USER_ID, 'n-1', NOW);

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'n-1',
          user_id: USER_ID,
          channel: 'IN_APP',
          read_at: null,
        },
        data: { read_at: NOW },
      });
    });

    it('marcar uno ya leído no es un error y no cambia su fecha', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      prisma.notification.count.mockResolvedValue(1);

      await expect(
        service.markRead(USER_ID, 'n-1', NOW),
      ).resolves.toBeUndefined();
    });

    it('un aviso ajeno o inexistente da 404', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      prisma.notification.count.mockResolvedValue(0);

      await expect(
        service.markRead(USER_ID, 'n-ajeno', NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
