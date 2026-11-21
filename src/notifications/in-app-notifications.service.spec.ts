import { Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email.service';
import { InAppNotificationsService } from './in-app-notifications.service';
import { PushService } from './push.service';

/** ENG-69 — la bandeja de avisos in-app y los avisos al profesional. */

const NOW = new Date('2026-10-21T15:00:00.000Z');
const APPOINTMENT_ID = 'turno-1';
const PRO_ID = 'pro-1';
const USER_ID = 'user-1';
const CONVERSATION_ID = 'conv-1';

const APPOINTMENT = {
  professional_id: PRO_ID,
  scheduled_at: new Date('2026-10-23T13:30:00.000Z'), // viernes 10:30 en AR
  duration_minutes: 30,
  patient: { first_name: 'Julián', last_name: 'Pérez' },
  professional: { first_name: 'Ana', profile: { email: 'ana@pro.test' } },
};

const NOW_AVISO = new Date('2026-10-31T12:00:00.000Z');

describe('InAppNotificationsService', () => {
  let prisma: {
    appointment: { findUnique: jest.Mock };
    notification: {
      create: jest.Mock;
      upsert: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let service: InAppNotificationsService;
  let email: { isConfigured: jest.Mock; send: jest.Mock };
  let push: { sendToUser: jest.Mock };
  let logError: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      appointment: { findUnique: jest.fn().mockResolvedValue(APPOINTMENT) },
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'n-1' }),
        upsert: jest.fn().mockResolvedValue({ id: 'n-1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    email = {
      isConfigured: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue('email-1'),
    };
    push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    service = new InAppNotificationsService(
      prisma as unknown as PrismaService,
      email as unknown as EmailService,
      push as unknown as PushService,
      {
        get: (key: string) =>
          key === 'WEB_ORIGIN' ? 'https://mediconnect.test' : undefined,
      } as unknown as ConfigService,
    );
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('notifyProfessional', () => {
    it('con replace reemplaza el aviso anterior y lo deja sin leer (ENG-203)', async () => {
      await service.notifyProfessional(
        APPOINTMENT_ID,
        'TURNO_REPROGRAMADO',
        NOW,
        { previousScheduledAt: '2026-08-24T13:00:00.000Z' },
        { replace: true },
      );

      expect(prisma.notification.create).not.toHaveBeenCalled();
      const args = prisma.notification.upsert.mock.calls[0][0];
      expect(args.where.appointment_id_type_channel).toEqual({
        appointment_id: APPOINTMENT_ID,
        type: 'TURNO_REPROGRAMADO',
        channel: 'IN_APP',
      });
      expect(args.update).toMatchObject({ read_at: null, sent_at: NOW });
      expect(args.create.payload).toMatchObject({
        previousScheduledAt: '2026-08-24T13:00:00.000Z',
      });
    });

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
            durationMinutes: 30,
          },
          sent_at: NOW,
        },
      });
    });

    it('también le manda el mail al profesional, con el mismo texto y el link al turno (ENG-208)', async () => {
      await service.notifyProfessional(APPOINTMENT_ID, 'PAGO_CONFIRMADO', NOW);

      expect(email.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'ana@pro.test',
          subject: 'Turno nuevo con Julián Pérez',
          text: expect.stringContaining(
            'Reservó y pagó una videoconsulta de 30 minutos',
          ),
          idempotencyKey: expect.stringMatching(/^turno-1:PAGO_CONFIRMADO:/),
        }),
      );
      expect(email.send.mock.calls[0][0].html).toContain(
        'https://mediconnect.test/turnos/turno-1',
      );
      expect(prisma.notification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            channel: 'EMAIL',
            user_id: PRO_ID,
          }),
        }),
      );
    });

    it('un mail que ya salió no se repite, salvo en los avisos que se repiten de verdad', async () => {
      prisma.notification.findUnique.mockResolvedValue({ id: 'mail-1' });

      await service.notifyProfessional(APPOINTMENT_ID, 'PAGO_CONFIRMADO', NOW);
      expect(email.send).not.toHaveBeenCalled();

      await service.notifyProfessional(
        APPOINTMENT_ID,
        'TURNO_REPROGRAMADO',
        NOW,
        { previousScheduledAt: '2026-10-22T13:30:00.000Z' },
        { replace: true },
      );
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(email.send.mock.calls[0][0].idempotencyKey).toContain(
        '2026-10-22T13:30:00.000Z',
      );
    });

    it('si el mail falla, el aviso in-app queda igual y no tira', async () => {
      email.send.mockRejectedValue(new Error('resend caído'));

      await expect(
        service.notifyProfessional(APPOINTMENT_ID, 'TURNO_CANCELADO', NOW),
      ).resolves.toBeUndefined();
      expect(prisma.notification.create).toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('No se pudo mandar el mail TURNO_CANCELADO'),
      );
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

  describe('notifyPatientPaymentApproved (ENG-199)', () => {
    const PAGADO = {
      patient_id: USER_ID,
      scheduled_at: new Date('2026-10-23T13:30:00.000Z'),
      professional: { first_name: 'Ana', last_name: 'García', currency: 'ARS' },
      payment: { amount: '9500.00', currency: 'ARS' },
    };

    it('deja el aviso en la bandeja del paciente con el monto y el profesional', async () => {
      prisma.appointment.findUnique.mockResolvedValue(PAGADO);

      await service.notifyPatientPaymentApproved(APPOINTMENT_ID, NOW);

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          user_id: USER_ID,
          appointment_id: APPOINTMENT_ID,
          type: 'PAGO_ACREDITADO',
          channel: 'IN_APP',
          payload: {
            appointmentId: APPOINTMENT_ID,
            professional: 'Ana García',
            scheduledAt: '2026-10-23T13:30:00.000Z',
            amount: 9500,
            currency: 'ARS',
          },
          sent_at: NOW,
        },
      });
      // ENG-208: y al celular, sin nombres ni montos, con el turno para abrirlo.
      expect(push.sendToUser).toHaveBeenCalledWith(USER_ID, {
        title: 'Tu turno está confirmado',
        body: 'Se acreditó tu pago. Abrí la app para ver el detalle.',
        data: { tipo: 'PAGO_ACREDITADO', appointmentId: APPOINTMENT_ID },
        channelId: 'turnos',
      });
    });

    it('un webhook duplicado no deja dos avisos ni loguea error', async () => {
      prisma.appointment.findUnique.mockResolvedValue(PAGADO);
      prisma.notification.create.mockRejectedValue({ code: 'P2002' });

      await expect(
        service.notifyPatientPaymentApproved(APPOINTMENT_ID, NOW),
      ).resolves.toBeUndefined();
      expect(logError).not.toHaveBeenCalled();
      // Tampoco vuelve a sonar el celular.
      expect(push.sendToUser).not.toHaveBeenCalled();
    });

    it('nunca tira: si la base falla, lo loguea y sigue', async () => {
      prisma.appointment.findUnique.mockRejectedValue(new Error('db caída'));

      await expect(
        service.notifyPatientPaymentApproved(APPOINTMENT_ID, NOW),
      ).resolves.toBeUndefined();
      expect(logError).toHaveBeenCalled();
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
            conversationId: null,
            createdAt: NOW.toISOString(),
            readAt: null,
            title: 'Turno nuevo con Julián Pérez',
            body: 'Reservó y pagó una videoconsulta para el viernes, 23 de octubre a las 10:30. El pago ya está acreditado.',
          },
        ],
      });
    });

    it('el aviso de mensaje nuevo trae su conversación, para que la campanita lleve al chat', async () => {
      prisma.notification.findMany.mockResolvedValue([
        {
          id: 'n-2',
          type: 'NUEVO_MENSAJE',
          payload: { conversationId: CONVERSATION_ID, from: 'Julián Pérez' },
          appointment_id: null,
          created_at: NOW,
          read_at: null,
        },
      ]);

      const { notifications } = await service.listMine(USER_ID);

      expect(notifications[0]).toMatchObject({
        conversationId: CONVERSATION_ID,
        appointmentId: null,
        body: 'Julián Pérez te escribió.',
      });
    });
  });

  describe('notifyMediPassAccess (ENG-177)', () => {
    const ACCESO = {
      sesionId: 's-1',
      consultante: 'Dra. Ferrer',
      matricula: null,
    };

    it('deja un aviso in-app para el paciente con quién entró', async () => {
      await service.notifyMediPassAccess('paciente-1', ACCESO, NOW_AVISO);

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          user_id: 'paciente-1',
          type: 'MEDIPASS_ACCESO',
          channel: 'IN_APP',
          payload: ACCESO,
          sent_at: NOW_AVISO,
        },
      });
    });

    it('omite el aviso si el mismo consultante ya avisó en la ventana', async () => {
      prisma.notification.findMany.mockResolvedValue([
        { payload: { consultante: ' dra. ferrer ', matricula: null } },
      ]);

      await service.notifyMediPassAccess('paciente-1', ACCESO, NOW_AVISO);

      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('avisa igual si cambia la matrícula o el nombre', async () => {
      prisma.notification.findMany.mockResolvedValue([
        { payload: { consultante: 'Dra. Ferrer', matricula: 'MP 1' } },
      ]);

      await service.notifyMediPassAccess('paciente-1', ACCESO, NOW_AVISO);

      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it('si falla, no tira: la ficha del médico no puede depender del aviso', async () => {
      prisma.notification.create.mockRejectedValue(new Error('base caída'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(
        service.notifyMediPassAccess('paciente-1', ACCESO, NOW_AVISO),
      ).resolves.toBeUndefined();
    });
  });

  describe('notifyNewMessage (ENG-70)', () => {
    const notices = {
      user_id: USER_ID,
      type: 'NUEVO_MENSAJE',
      channel: 'IN_APP',
      payload: { path: ['conversationId'], equals: CONVERSATION_ID },
    };

    it('deja un aviso con la conversación y quién escribió', async () => {
      const created = await service.notifyNewMessage(
        USER_ID,
        CONVERSATION_ID,
        'Julián Pérez',
        NOW,
      );

      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { ...notices, read_at: null },
      });
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          user_id: USER_ID,
          type: 'NUEVO_MENSAJE',
          channel: 'IN_APP',
          payload: { conversationId: CONVERSATION_ID, from: 'Julián Pérez' },
          sent_at: NOW,
        },
      });
      expect(created).toBe(true);
    });

    it('con archivo, marca el aviso como adjunto', async () => {
      await service.notifyNewMessage(
        USER_ID,
        CONVERSATION_ID,
        'Julián',
        NOW,
        true,
      );

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: {
            conversationId: CONVERSATION_ID,
            from: 'Julián',
            adjunto: true,
          },
        }),
      });
    });

    it('si ya hay un aviso sin leer de esa conversación, no deja otro', async () => {
      prisma.notification.count.mockResolvedValue(1);

      const created = await service.notifyNewMessage(
        USER_ID,
        CONVERSATION_ID,
        'Julián',
        NOW,
      );

      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(created).toBe(false);
    });

    it('nunca tira: si la base falla, lo loguea y sigue', async () => {
      prisma.notification.create.mockRejectedValue(new Error('db caída'));

      await expect(
        service.notifyNewMessage(USER_ID, CONVERSATION_ID, 'Julián', NOW),
      ).resolves.toBe(false);
      expect(logError).toHaveBeenCalled();
    });

    it('abrir el chat apaga su aviso', async () => {
      await service.markConversationRead(USER_ID, CONVERSATION_ID, NOW);

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { ...notices, read_at: null },
        data: { read_at: NOW },
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
