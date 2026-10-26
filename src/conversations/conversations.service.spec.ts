import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CHAT_ENABLING_STATUSES,
  ConversationsService,
  MESSAGES_PAGE_SIZE,
} from './conversations.service';

/** ENG-70 — el chat paciente–profesional. */

const NOW = new Date('2026-10-26T15:00:00.000Z');
const PATIENT_ID = 'paciente-1';
const PRO_ID = 'pro-1';
const OTHER_PRO_ID = 'pro-2';
const CONVERSATION_ID = 'conv-1';

const PATIENT = {
  profile_id: PATIENT_ID,
  first_name: 'Julián',
  last_name: 'Pérez',
};
const PRO = { profile_id: PRO_ID, first_name: 'Laura', last_name: 'Gómez' };
const OTHER_PRO = {
  profile_id: OTHER_PRO_ID,
  first_name: 'Andrés',
  last_name: 'Ruiz',
};

function messageRow(id: string, sender: string, at: string, read?: string) {
  return {
    id,
    conversation_id: CONVERSATION_ID,
    sender_id: sender,
    content: `mensaje ${id}`,
    created_at: new Date(at),
    read_at: read ? new Date(read) : null,
  };
}

describe('ConversationsService', () => {
  let prisma: {
    profile: { findUnique: jest.Mock };
    conversation: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      upsert: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
      update: jest.Mock;
    };
    message: {
      groupBy: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
    appointment: { count: jest.Mock; findMany: jest.Mock };
    patient: { findUnique: jest.Mock };
    professional: { findUnique: jest.Mock };
  };
  let notifications: {
    notifyNewMessage: jest.Mock;
    markConversationRead: jest.Mock;
  };
  let service: ConversationsService;

  function asRole(role: string | null) {
    prisma.profile.findUnique.mockResolvedValue(role ? { role } : null);
  }

  beforeEach(() => {
    prisma = {
      profile: { findUnique: jest.fn() },
      conversation: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          patient_id: PATIENT_ID,
          professional_id: PRO_ID,
        }),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      message: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      appointment: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([]),
      },
      patient: { findUnique: jest.fn().mockResolvedValue(PATIENT) },
      professional: { findUnique: jest.fn().mockResolvedValue(PRO) },
    };
    notifications = {
      notifyNewMessage: jest.fn().mockResolvedValue(undefined),
      markConversationRead: jest.fn().mockResolvedValue(undefined),
    };
    service = new ConversationsService(
      prisma as unknown as PrismaService,
      notifications as unknown as InAppNotificationsService,
    );
    asRole('PACIENTE');
  });

  describe('listMine', () => {
    it('lista las conversaciones del paciente con el profesional como contraparte, la más activa primero', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        {
          id: 'vieja',
          created_at: new Date('2026-10-01T10:00:00.000Z'),
          patient: PATIENT,
          professional: OTHER_PRO,
          messages: [
            messageRow('m-1', OTHER_PRO_ID, '2026-10-02T10:00:00.000Z'),
          ],
        },
        {
          id: CONVERSATION_ID,
          created_at: new Date('2026-10-20T10:00:00.000Z'),
          patient: PATIENT,
          professional: PRO,
          messages: [],
        },
      ]);
      prisma.message.groupBy.mockResolvedValue([
        { conversation_id: 'vieja', _count: { _all: 3 } },
      ]);

      const inbox = await service.listMine(PATIENT_ID);

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { patient_id: PATIENT_ID, patient_hidden_at: null },
        }),
      );
      expect(prisma.message.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            conversation_id: { in: ['vieja', CONVERSATION_ID] },
            sender_id: { not: PATIENT_ID },
            read_at: null,
          },
        }),
      );
      // Sin mensajes, ordena por cuándo se abrió: la del 20/10 va antes.
      expect(inbox.conversaciones.map((c) => c.id)).toEqual([
        CONVERSATION_ID,
        'vieja',
      ]);
      expect(inbox.conversaciones[1]).toEqual({
        id: 'vieja',
        contraparte: {
          id: OTHER_PRO_ID,
          nombre: 'Andrés Ruiz',
          rol: 'PROFESIONAL',
        },
        ultimoMensaje: {
          id: 'm-1',
          conversacionId: CONVERSATION_ID,
          autorId: OTHER_PRO_ID,
          contenido: 'mensaje m-1',
          enviadoEl: '2026-10-02T10:00:00.000Z',
          leidoEl: null,
        },
        noLeidos: 3,
        creadaEl: '2026-10-01T10:00:00.000Z',
      });
      expect(inbox.conversaciones[0].noLeidos).toBe(0);
    });

    it('del lado del profesional, la contraparte es el paciente', async () => {
      asRole('PROFESIONAL');
      prisma.conversation.findMany.mockResolvedValue([
        {
          id: CONVERSATION_ID,
          created_at: NOW,
          patient: PATIENT,
          professional: PRO,
          messages: [],
        },
      ]);

      const inbox = await service.listMine(PRO_ID);

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { professional_id: PRO_ID, professional_hidden_at: null },
        }),
      );
      expect(inbox.conversaciones[0].contraparte).toEqual({
        id: PATIENT_ID,
        nombre: 'Julián Pérez',
        rol: 'PACIENTE',
      });
    });

    it('ofrece abrir chat con quien hubo turno pagado y todavía no hay conversación', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        {
          id: CONVERSATION_ID,
          created_at: NOW,
          patient: PATIENT,
          professional: PRO,
          messages: [],
        },
      ]);
      prisma.appointment.findMany.mockResolvedValue([
        { patient: PATIENT, professional: PRO },
        { patient: PATIENT, professional: OTHER_PRO },
      ]);

      const { disponibles } = await service.listMine(PATIENT_ID);

      expect(prisma.appointment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            patient_id: PATIENT_ID,
            status: { in: CHAT_ENABLING_STATUSES },
          },
          distinct: ['professional_id'],
        }),
      );
      expect(disponibles).toEqual([
        { id: OTHER_PRO_ID, nombre: 'Andrés Ruiz', rol: 'PROFESIONAL' },
      ]);
    });

    it('sin conversaciones no consulta los no leídos', async () => {
      await service.listMine(PATIENT_ID);
      expect(prisma.message.groupBy).not.toHaveBeenCalled();
    });

    it('un moderador o un perfil inexistente no tiene chat (409)', async () => {
      for (const role of ['MODERADOR', null]) {
        asRole(role);
        await expect(service.listMine('x')).rejects.toBeInstanceOf(
          ConflictException,
        );
      }
    });
  });

  describe('open', () => {
    it('sin turno pagado entre los dos da 403 y no crea nada', async () => {
      prisma.appointment.count.mockResolvedValue(0);

      await expect(service.open(PATIENT_ID, PRO_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.appointment.count).toHaveBeenCalledWith({
        where: {
          patient_id: PATIENT_ID,
          professional_id: PRO_ID,
          status: { in: CHAT_ENABLING_STATUSES },
        },
      });
      expect(prisma.conversation.upsert).not.toHaveBeenCalled();
    });

    it('con turno, la abre (o reusa la existente) y la devuelve', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        {
          id: CONVERSATION_ID,
          created_at: NOW,
          patient: PATIENT,
          professional: PRO,
          messages: [],
        },
      ]);

      const opened = await service.open(PATIENT_ID, PRO_ID);

      expect(prisma.conversation.upsert).toHaveBeenCalledWith({
        where: {
          patient_id_professional_id: {
            patient_id: PATIENT_ID,
            professional_id: PRO_ID,
          },
        },
        create: { patient_id: PATIENT_ID, professional_id: PRO_ID },
        // Si el paciente la había ocultado, vuelve a su bandeja.
        update: { patient_hidden_at: null },
      });
      expect(opened.id).toBe(CONVERSATION_ID);
    });

    it('la puede abrir el profesional: él queda como profesional del par', async () => {
      asRole('PROFESIONAL');
      prisma.conversation.findMany.mockResolvedValue([
        {
          id: CONVERSATION_ID,
          created_at: NOW,
          patient: PATIENT,
          professional: PRO,
          messages: [],
        },
      ]);

      await service.open(PRO_ID, PATIENT_ID);

      expect(prisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: { patient_id: PATIENT_ID, professional_id: PRO_ID },
        }),
      );
    });
  });

  describe('listMessages', () => {
    it('una conversación ajena da 404 sin leer mensajes', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      await expect(
        service.listMessages('intruso', CONVERSATION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: CONVERSATION_ID,
            OR: [{ patient_id: 'intruso' }, { professional_id: 'intruso' }],
          },
        }),
      );
      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });

    it('devuelve la última página en orden cronológico', async () => {
      prisma.message.findMany.mockResolvedValue([
        messageRow('m-2', PRO_ID, '2026-10-26T14:00:00.000Z'),
        messageRow('m-1', PATIENT_ID, '2026-10-26T13:00:00.000Z'),
      ]);

      const page = await service.listMessages(PATIENT_ID, CONVERSATION_ID);

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversation_id: CONVERSATION_ID },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          take: MESSAGES_PAGE_SIZE + 1,
        }),
      );
      expect(page.mensajes.map((m) => m.id)).toEqual(['m-1', 'm-2']);
      expect(page.hayMas).toBe(false);
    });

    it('con una fila de más avisa que hay mensajes anteriores', async () => {
      prisma.message.findMany.mockResolvedValue(
        Array.from({ length: MESSAGES_PAGE_SIZE + 1 }, (_, i) =>
          messageRow(`m-${i}`, PRO_ID, NOW.toISOString()),
        ),
      );

      const page = await service.listMessages(PATIENT_ID, CONVERSATION_ID);

      expect(page.mensajes).toHaveLength(MESSAGES_PAGE_SIZE);
      expect(page.hayMas).toBe(true);
    });

    it('antesDe pagina hacia atrás desde ese mensaje, con el id como desempate', async () => {
      const anchorAt = new Date('2026-10-26T13:00:00.000Z');
      prisma.message.findFirst.mockResolvedValue({
        id: 'm-50',
        created_at: anchorAt,
      });

      await service.listMessages(PATIENT_ID, CONVERSATION_ID, 'm-50');

      expect(prisma.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'm-50', conversation_id: CONVERSATION_ID },
        }),
      );
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            conversation_id: CONVERSATION_ID,
            OR: [
              { created_at: { lt: anchorAt } },
              { created_at: anchorAt, id: { lt: 'm-50' } },
            ],
          },
        }),
      );
    });

    it('un antesDe de otra conversación da 404', async () => {
      prisma.message.findFirst.mockResolvedValue(null);

      await expect(
        service.listMessages(PATIENT_ID, CONVERSATION_ID, 'de-otra'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('send', () => {
    beforeEach(() => {
      prisma.message.create.mockResolvedValue(
        messageRow('m-nuevo', PATIENT_ID, NOW.toISOString()),
      );
    });

    it('guarda el mensaje y avisa a la otra persona con el nombre de quien escribe', async () => {
      const sent = await service.send(
        PATIENT_ID,
        CONVERSATION_ID,
        'Hola, doctora',
        NOW,
      );

      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            conversation_id: CONVERSATION_ID,
            sender_id: PATIENT_ID,
            content: 'Hola, doctora',
            created_at: NOW,
          },
        }),
      );
      expect(notifications.notifyNewMessage).toHaveBeenCalledWith(
        PRO_ID,
        CONVERSATION_ID,
        'Julián Pérez',
        NOW,
      );
      expect(sent.id).toBe('m-nuevo');
    });

    it('si escribe el profesional, el aviso va al paciente', async () => {
      await service.send(PRO_ID, CONVERSATION_ID, 'Hola, Julián', NOW);

      expect(notifications.notifyNewMessage).toHaveBeenCalledWith(
        PATIENT_ID,
        CONVERSATION_ID,
        'Laura Gómez',
        NOW,
      );
    });

    it('en una conversación ajena da 404 y no guarda nada', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      await expect(
        service.send('intruso', CONVERSATION_ID, 'hola', NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(notifications.notifyNewMessage).not.toHaveBeenCalled();
    });
  });

  describe('markRead', () => {
    it('marca en bloque lo que mandó la otra persona y apaga el aviso', async () => {
      await service.markRead(PATIENT_ID, CONVERSATION_ID, NOW);

      expect(prisma.message.updateMany).toHaveBeenCalledWith({
        where: {
          conversation_id: CONVERSATION_ID,
          sender_id: { not: PATIENT_ID },
          read_at: null,
        },
        data: { read_at: NOW },
      });
      expect(notifications.markConversationRead).toHaveBeenCalledWith(
        PATIENT_ID,
        CONVERSATION_ID,
        NOW,
      );
    });

    it('en una conversación ajena da 404', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      await expect(
        service.markRead('intruso', CONVERSATION_ID, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.message.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('hide (Borrar chat)', () => {
    it('un chat sin mensajes se elimina, en una sola sentencia', async () => {
      prisma.conversation.deleteMany.mockResolvedValue({ count: 1 });

      await service.hide(PATIENT_ID, CONVERSATION_ID, NOW);

      expect(prisma.conversation.deleteMany).toHaveBeenCalledWith({
        where: { id: CONVERSATION_ID, messages: { none: {} } },
      });
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });

    it('con mensajes, lo oculta solo para quien lo borra', async () => {
      await service.hide(PATIENT_ID, CONVERSATION_ID, NOW);

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: CONVERSATION_ID },
        data: { patient_hidden_at: NOW },
      });
    });

    it('del lado del profesional, marca la columna del profesional', async () => {
      await service.hide(PRO_ID, CONVERSATION_ID, NOW);

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: CONVERSATION_ID },
        data: { professional_hidden_at: NOW },
      });
    });

    it('una conversación ajena da 404 y no toca nada', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      await expect(
        service.hide('intruso', CONVERSATION_ID, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.conversation.deleteMany).not.toHaveBeenCalled();
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });

    it('un mensaje nuevo la devuelve a las dos bandejas', async () => {
      prisma.message.create.mockResolvedValue(
        messageRow('m-nuevo', PRO_ID, NOW.toISOString()),
      );

      await service.send(PRO_ID, CONVERSATION_ID, 'Hola de nuevo', NOW);

      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: {
          id: CONVERSATION_ID,
          OR: [
            { patient_hidden_at: { not: null } },
            { professional_hidden_at: { not: null } },
          ],
        },
        data: { patient_hidden_at: null, professional_hidden_at: null },
      });
    });
  });
});
