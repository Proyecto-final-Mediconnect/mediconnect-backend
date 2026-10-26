import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { appointment_status } from '../../generated/prisma';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { PrismaService } from '../prisma/prisma.service';

/** Cuántos mensajes trae cada página del historial. */
export const MESSAGES_PAGE_SIZE = 50;

/**
 * Turnos que habilitan el chat: los que el paciente pagó, ya hayan pasado o
 * no. Una reserva sin pagar es una retención que se libera sola (ENG-101), y
 * un turno cancelado o liberado no dice que esas dos personas se conozcan.
 */
export const CHAT_ENABLING_STATUSES: appointment_status[] = [
  'CONFIRMADO',
  'COMPLETADO',
  'NO_ASISTIO',
];

type ChatRole = 'PACIENTE' | 'PROFESIONAL';

export interface ChatCounterpart {
  id: string;
  nombre: string;
  rol: ChatRole;
}

export interface ChatMessage {
  id: string;
  conversacionId: string;
  autorId: string;
  contenido: string;
  enviadoEl: string;
  leidoEl: string | null;
}

export interface ConversationSummary {
  id: string;
  contraparte: ChatCounterpart;
  ultimoMensaje: ChatMessage | null;
  noLeidos: number;
  creadaEl: string;
}

/** `GET /conversations/me`. */
export interface ConversationInbox {
  conversaciones: ConversationSummary[];
  /** Con quién se puede abrir una conversación nueva: hay turno y todavía no hay chat. */
  disponibles: ChatCounterpart[];
}

/** `GET /conversations/:id/messages`, en orden cronológico. */
export interface MessagesPage {
  mensajes: ChatMessage[];
  hayMas: boolean;
}

const MESSAGE_SELECT = {
  id: true,
  conversation_id: true,
  sender_id: true,
  content: true,
  created_at: true,
  read_at: true,
} as const;

const PERSON_SELECT = {
  profile_id: true,
  first_name: true,
  last_name: true,
} as const;

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string | null;
  created_at: Date;
  read_at: Date | null;
}

interface PersonRow {
  profile_id: string;
  first_name: string;
  last_name: string;
}

interface Participants {
  patient_id: string;
  professional_id: string;
}

/**
 * Chat persistente paciente–profesional (ENG-70, HU-28 y HU-29).
 *
 * ## Quién puede hablar con quién
 *
 * Una conversación se abre solo si hay un turno pagado entre esas dos personas
 * (`CHAT_ENABLING_STATUSES`). La puede abrir cualquiera de los dos: el paciente
 * para preguntar algo después de la consulta, el profesional para hacer un
 * seguimiento. Abierta, queda abierta: un turno cancelado después no corta una
 * conversación que ya existe.
 *
 * ## Fuente de verdad
 *
 * Todo pasa por acá: Realtime (ADR-011) solo le avisa al cliente que llegó un
 * mensaje, con RLS de la migración de ENG-70. El spike ENG-52 perdió un evento
 * en 1 de 6 corridas, así que el cliente trae el historial por HTTP después de
 * suscribirse y reconcilia por `id`. Este service no sabe que Realtime existe.
 *
 * El backend conecta con el rol dueño de las tablas, al que RLS no se le aplica:
 * cada consulta filtra por el usuario del token, nunca por un id de la URL sin
 * verificar que sea participante.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: InAppNotificationsService,
  ) {}

  /** Las conversaciones del usuario, la más activa primero, y con quién puede abrir una nueva. */
  async listMine(userId: string): Promise<ConversationInbox> {
    const role = await this.chatRole(userId);
    // Las que el usuario ocultó ("Borrar chat") no se listan. Su contraparte sí
    // vuelve a aparecer en `disponibles`, por si quiere escribirle de nuevo.
    const mine =
      role === 'PACIENTE'
        ? { patient_id: userId, patient_hidden_at: null }
        : { professional_id: userId, professional_hidden_at: null };

    const rows = await this.prisma.conversation.findMany({
      where: mine,
      select: {
        id: true,
        created_at: true,
        patient: { select: PERSON_SELECT },
        professional: { select: PERSON_SELECT },
        messages: {
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          take: 1,
          select: MESSAGE_SELECT,
        },
      },
    });

    const unread = rows.length
      ? await this.prisma.message.groupBy({
          by: ['conversation_id'],
          where: {
            conversation_id: { in: rows.map((row) => row.id) },
            sender_id: { not: userId },
            read_at: null,
          },
          _count: { _all: true },
        })
      : [];
    const unreadBy = new Map(
      unread.map((u) => [u.conversation_id, u._count._all]),
    );

    const conversaciones = rows
      .map((row) => {
        const last = row.messages[0];
        return {
          id: row.id,
          contraparte:
            role === 'PACIENTE'
              ? toCounterpart(row.professional, 'PROFESIONAL')
              : toCounterpart(row.patient, 'PACIENTE'),
          ultimoMensaje: last ? toChatMessage(last) : null,
          noLeidos: unreadBy.get(row.id) ?? 0,
          creadaEl: row.created_at.toISOString(),
        };
      })
      .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));

    const taken = new Set(conversaciones.map((c) => c.contraparte.id));
    const disponibles = (await this.eligibleCounterparts(userId, role)).filter(
      (person) => !taken.has(person.id),
    );

    return { conversaciones, disponibles };
  }

  /**
   * Abre la conversación con `counterpartId`, o devuelve la que ya existe.
   *
   * Sin turno pagado entre los dos da 403. Es idempotente: dos pedidos a la vez
   * (doble click, dos pestañas) terminan en la misma fila por el único
   * `(patient_id, professional_id)`. Si el usuario la había ocultado, vuelve a
   * su bandeja con el historial.
   *
   * La web la llama recién al mandar el primer mensaje, no al elegir con quién
   * hablar: así no quedan chats vacíos en ninguna de las dos bandejas.
   */
  async open(
    userId: string,
    counterpartId: string,
  ): Promise<ConversationSummary> {
    const role = await this.chatRole(userId);
    const pair: Participants =
      role === 'PACIENTE'
        ? { patient_id: userId, professional_id: counterpartId }
        : { patient_id: counterpartId, professional_id: userId };

    const hasAppointment = await this.prisma.appointment.count({
      where: { ...pair, status: { in: CHAT_ENABLING_STATUSES } },
    });
    if (hasAppointment === 0) {
      throw new ForbiddenException(
        'Solo podés escribirle a alguien con quien tuviste un turno.',
      );
    }

    await this.prisma.conversation.upsert({
      where: { patient_id_professional_id: pair },
      create: pair,
      update:
        role === 'PACIENTE'
          ? { patient_hidden_at: null }
          : { professional_hidden_at: null },
    });

    const inbox = await this.listMine(userId);
    const opened = inbox.conversaciones.find(
      (c) => c.contraparte.id === counterpartId,
    );
    // Recién creada o ya existente, tiene que estar: si no, la consulta de la
    // bandeja y la de arriba no coinciden en qué es "mía".
    if (!opened) throw new NotFoundException('Esa conversación no existe.');
    return opened;
  }

  /**
   * Una página del historial, en orden cronológico. Sin `beforeId`, los
   * mensajes más recientes; con él, los anteriores a ese mensaje.
   */
  async listMessages(
    userId: string,
    conversationId: string,
    beforeId?: string,
  ): Promise<MessagesPage> {
    await this.participantsOf(userId, conversationId);

    let cursor: { created_at: Date; id: string } | undefined;
    if (beforeId) {
      const anchor = await this.prisma.message.findFirst({
        where: { id: beforeId, conversation_id: conversationId },
        select: { id: true, created_at: true },
      });
      if (!anchor) throw new NotFoundException('Ese mensaje no existe.');
      cursor = anchor;
    }

    // El `id` desempata dos mensajes del mismo instante: sin él una página
    // podría repetir o saltear uno.
    const rows = await this.prisma.message.findMany({
      where: {
        conversation_id: conversationId,
        ...(cursor && {
          OR: [
            { created_at: { lt: cursor.created_at } },
            { created_at: cursor.created_at, id: { lt: cursor.id } },
          ],
        }),
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: MESSAGES_PAGE_SIZE + 1,
      select: MESSAGE_SELECT,
    });

    return {
      mensajes: rows.slice(0, MESSAGES_PAGE_SIZE).reverse().map(toChatMessage),
      hayMas: rows.length > MESSAGES_PAGE_SIZE,
    };
  }

  /** Manda un mensaje y le deja el aviso in-app a la otra persona. */
  async send(
    userId: string,
    conversationId: string,
    content: string,
    now: Date = new Date(),
  ): Promise<ChatMessage> {
    const conversation = await this.participantsOf(userId, conversationId);

    const row = await this.prisma.message.create({
      data: {
        conversation_id: conversationId,
        sender_id: userId,
        content,
        created_at: now,
      },
      select: MESSAGE_SELECT,
    });

    // Un mensaje nuevo devuelve el chat a la bandeja de quien lo había ocultado.
    // El filtro hace que casi siempre sea un UPDATE que no toca ninguna fila.
    await this.prisma.conversation.updateMany({
      where: {
        id: conversationId,
        OR: [
          { patient_hidden_at: { not: null } },
          { professional_hidden_at: { not: null } },
        ],
      },
      data: { patient_hidden_at: null, professional_hidden_at: null },
    });

    const recipientId =
      conversation.patient_id === userId
        ? conversation.professional_id
        : conversation.patient_id;
    await this.notifications.notifyNewMessage(
      recipientId,
      conversationId,
      await this.displayName(userId, conversation),
      now,
    );

    return toChatMessage(row);
  }

  /**
   * Marca como leído todo lo que la otra persona mandó en la conversación, y su
   * aviso in-app.
   *
   * En bloque y no mensaje por mensaje (recomendación 5 del spike): abrir un chat
   * con 30 mensajes nuevos es un UPDATE, no 30.
   */
  async markRead(
    userId: string,
    conversationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.participantsOf(userId, conversationId);
    await this.prisma.message.updateMany({
      where: {
        conversation_id: conversationId,
        sender_id: { not: userId },
        read_at: null,
      },
      data: { read_at: now },
    });
    await this.notifications.markConversationRead(userId, conversationId, now);
  }

  /**
   * "Borrar chat": lo saca de la bandeja de `userId` y de nadie más.
   *
   * Los mensajes no se borran: la otra persona sigue viendo la conversación, y
   * puede tener indicaciones médicas. Si cualquiera de los dos escribe de nuevo,
   * vuelve a aparecer. Un chat **sin mensajes** sí se elimina, en una sola
   * sentencia que no borra nada si justo entró un mensaje.
   */
  async hide(
    userId: string,
    conversationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const conversation = await this.participantsOf(userId, conversationId);

    const { count } = await this.prisma.conversation.deleteMany({
      where: { id: conversationId, messages: { none: {} } },
    });
    if (count > 0) return;

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:
        conversation.patient_id === userId
          ? { patient_hidden_at: now }
          : { professional_hidden_at: now },
    });
  }

  /**
   * Los participantes de la conversación, si `userId` es uno de ellos.
   *
   * Una conversación ajena da 404, igual que una inexistente: un 403 confirmaría
   * que el id existe.
   */
  private async participantsOf(
    userId: string,
    conversationId: string,
  ): Promise<Participants> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        OR: [{ patient_id: userId }, { professional_id: userId }],
      },
      select: { patient_id: true, professional_id: true },
    });
    if (!conversation) {
      throw new NotFoundException('Esa conversación no existe.');
    }
    return conversation;
  }

  /** El chat es entre paciente y profesional: un moderador o un perfil a medias no tiene bandeja. */
  private async chatRole(userId: string): Promise<ChatRole> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (profile?.role === 'PACIENTE' || profile?.role === 'PROFESIONAL') {
      return profile.role;
    }
    throw new ConflictException(
      'El chat es solo para pacientes y profesionales.',
    );
  }

  /** Las personas con las que el usuario tuvo un turno pagado. */
  private async eligibleCounterparts(
    userId: string,
    role: ChatRole,
  ): Promise<ChatCounterpart[]> {
    const appointments = await this.prisma.appointment.findMany({
      where: {
        ...(role === 'PACIENTE'
          ? { patient_id: userId }
          : { professional_id: userId }),
        status: { in: CHAT_ENABLING_STATUSES },
      },
      distinct: [role === 'PACIENTE' ? 'professional_id' : 'patient_id'],
      select: {
        patient: { select: PERSON_SELECT },
        professional: { select: PERSON_SELECT },
      },
    });

    return appointments
      .map((a) =>
        role === 'PACIENTE'
          ? toCounterpart(a.professional, 'PROFESIONAL')
          : toCounterpart(a.patient, 'PACIENTE'),
      )
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  /** Cómo se presenta quien escribe en el aviso de la otra persona. */
  private async displayName(
    userId: string,
    conversation: Participants,
  ): Promise<string> {
    const person =
      conversation.patient_id === userId
        ? await this.prisma.patient.findUnique({
            where: { profile_id: userId },
            select: PERSON_SELECT,
          })
        : await this.prisma.professional.findUnique({
            where: { profile_id: userId },
            select: PERSON_SELECT,
          });
    return person ? fullName(person) : '';
  }
}

function toChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversacionId: row.conversation_id,
    autorId: row.sender_id,
    contenido: row.content ?? '',
    enviadoEl: row.created_at.toISOString(),
    leidoEl: row.read_at?.toISOString() ?? null,
  };
}

function toCounterpart(person: PersonRow, rol: ChatRole): ChatCounterpart {
  return { id: person.profile_id, nombre: fullName(person), rol };
}

function fullName(person: PersonRow): string {
  return `${person.first_name} ${person.last_name}`.trim();
}

/** Una conversación sin mensajes ordena por cuándo se abrió. */
function lastActivity(c: ConversationSummary): string {
  return c.ultimoMensaje?.enviadoEl ?? c.creadaEl;
}
