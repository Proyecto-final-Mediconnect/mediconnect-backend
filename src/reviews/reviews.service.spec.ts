import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ReviewsService, shortName } from './reviews.service';

/** ENG-80, ENG-81 y ENG-82: dejar, moderar y mostrar reseñas. */

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const MOD = '33333333-3333-4333-8333-333333333333';
const TURNO = '44444444-4444-4444-8444-444444444444';
const RESENA = '55555555-5555-4555-8555-555555555555';
const CREATED = new Date('2026-11-01T15:00:00.000Z');

const FILA_PROPIA = {
  id: RESENA,
  appointment_id: TURNO,
  professional_id: PRO,
  rating: 5,
  comment: 'Muy clara.',
  status: 'PENDIENTE_MODERACION' as const,
  moderation_reason: null,
  created_at: CREATED,
};

const FILA_MODERACION = {
  id: RESENA,
  rating: 4,
  comment: 'Buena atención.',
  status: 'APROBADA' as const,
  created_at: CREATED,
  moderation_reason: null,
  moderated_at: new Date('2026-11-02T15:00:00.000Z'),
  patient: { first_name: 'Marina', last_name: 'López' },
  professional: { profile_id: PRO, first_name: 'Ana', last_name: 'García' },
  appointment_id: TURNO,
  patient_id: PATIENT,
};

describe('ReviewsService', () => {
  let service: ReviewsService;
  let prisma: {
    appointment: { findUnique: jest.Mock };
    review: {
      create: jest.Mock;
      findMany: jest.Mock;
      groupBy: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    profile: { findUnique: jest.Mock };
    reviewResponse: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
    };
    $transaction: jest.Mock;
    auditLog: { create: jest.Mock };
    notification: { create: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      appointment: {
        findUnique: jest.fn().mockResolvedValue({
          patient_id: PATIENT,
          professional_id: PRO,
          status: 'COMPLETADO',
          review: null,
        }),
      },
      review: {
        create: jest.fn().mockResolvedValue(FILA_PROPIA),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ id: RESENA }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(FILA_MODERACION),
      },
      profile: {
        findUnique: jest.fn().mockResolvedValue({ role: 'MODERADOR' }),
      },
      reviewResponse: {
        upsert: jest.fn().mockResolvedValue({
          review_id: RESENA,
          content: 'Gracias por la devolución.',
          created_at: CREATED,
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ content: 'Versión vieja.' }),
        findFirst: jest.fn().mockResolvedValue({ content: 'Versión vieja.' }),
      },
      $transaction: jest.fn(),
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      notification: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(prisma),
    );
    service = new ReviewsService(prisma as unknown as PrismaService);
  });

  describe('create (ENG-80)', () => {
    it('deja la reseña de una consulta propia y terminada, pendiente de moderación', async () => {
      const view = await service.create(PATIENT, TURNO, {
        rating: 5,
        comment: 'Muy clara.',
      });

      expect(prisma.review.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            patient_id: PATIENT,
            professional_id: PRO,
            appointment_id: TURNO,
            rating: 5,
            comment: 'Muy clara.',
          },
        }),
      );
      expect(view).toMatchObject({ status: 'PENDIENTE_MODERACION', rating: 5 });
    });

    it('un turno ajeno da 404, igual que uno inexistente', async () => {
      prisma.appointment.findUnique.mockResolvedValue({
        patient_id: PRO,
        professional_id: PRO,
        status: 'COMPLETADO',
        review: null,
      });
      await expect(
        service.create(PATIENT, TURNO, { rating: 4 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it('una consulta que no se hizo no se reseña', async () => {
      prisma.appointment.findUnique.mockResolvedValue({
        patient_id: PATIENT,
        professional_id: PRO,
        status: 'CONFIRMADO',
        review: null,
      });
      await expect(
        service.create(PATIENT, TURNO, { rating: 4 }),
      ).rejects.toThrow('Solo se puede reseñar una consulta que ya se hizo.');
    });

    it('una sola reseña por turno', async () => {
      prisma.appointment.findUnique.mockResolvedValue({
        patient_id: PATIENT,
        professional_id: PRO,
        status: 'COMPLETADO',
        review: { id: RESENA },
      });
      await expect(
        service.create(PATIENT, TURNO, { rating: 4 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('dos envíos a la vez: el segundo choca con el índice único y da 409', async () => {
      prisma.review.create.mockRejectedValue(
        Object.assign(new Error('dup'), { code: 'P2002' }),
      );
      await expect(
        service.create(PATIENT, TURNO, { rating: 4 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('promedio y reseñas aprobadas (ENG-82)', () => {
    it('promedia solo las aprobadas, con un decimal', async () => {
      prisma.review.groupBy.mockResolvedValue([
        { professional_id: PRO, _avg: { rating: 4.666 }, _count: { _all: 3 } },
      ]);

      const ratings = await service.ratingSummaries([PRO]);

      expect(ratings.get(PRO)).toEqual({ average: 4.7, count: 3 });
      expect(prisma.review.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { professional_id: { in: [PRO] }, status: 'APROBADA' },
        }),
      );
    });

    it('sin profesionales no consulta', async () => {
      await expect(service.ratingSummaries([])).resolves.toEqual(new Map());
      expect(prisma.review.groupBy).not.toHaveBeenCalled();
    });

    it('lista las aprobadas con el autor abreviado y la respuesta del profesional', async () => {
      prisma.review.findMany.mockResolvedValue([
        {
          id: RESENA,
          rating: 5,
          comment: 'Muy clara.',
          created_at: CREATED,
          patient: { first_name: 'Julián', last_name: 'Sosa' },
          response: { content: 'Gracias.', created_at: CREATED },
        },
      ]);
      prisma.review.groupBy.mockResolvedValue([
        { professional_id: PRO, _avg: { rating: 5 }, _count: { _all: 1 } },
      ]);

      const page = await service.listApproved(PRO, 1);

      expect(page).toEqual({
        reviews: [
          {
            id: RESENA,
            rating: 5,
            comment: 'Muy clara.',
            author: 'Julián S.',
            createdAt: CREATED.toISOString(),
            response: { content: 'Gracias.', createdAt: CREATED.toISOString() },
          },
        ],
        rating: { average: 5, count: 1 },
        page: 1,
        hasMore: false,
      });
      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { professional_id: PRO, status: 'APROBADA' },
        }),
      );
    });

    it('abrevia el apellido', () => {
      expect(shortName('Julián', 'sosa')).toBe('Julián S.');
      expect(shortName('Ana', '')).toBe('Ana');
    });
  });

  describe('moderación (ENG-81)', () => {
    it('solo un moderador ve la cola', async () => {
      prisma.profile.findUnique.mockResolvedValue({ role: 'PACIENTE' });
      await expect(
        service.listForModeration(PATIENT, 'PENDIENTE_MODERACION', 1),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.review.findMany).not.toHaveBeenCalled();
    });

    it('la cola de pendientes arranca por la más vieja', async () => {
      await service.listForModeration(MOD, 'PENDIENTE_MODERACION', 1);
      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'PENDIENTE_MODERACION' },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        }),
      );
    });

    it('aprobar escribe la decisión solo si sigue pendiente, la audita y avisa al paciente', async () => {
      const now = new Date('2026-11-02T15:00:00.000Z');
      const view = await service.moderate(
        MOD,
        RESENA,
        { decision: 'APROBADA' },
        now,
      );

      expect(prisma.review.updateMany).toHaveBeenCalledWith({
        where: { id: RESENA, status: 'PENDIENTE_MODERACION' },
        data: {
          status: 'APROBADA',
          moderator_id: MOD,
          moderation_reason: null,
          moderated_at: now,
        },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: MOD,
          action: 'REVIEW_MODERATED',
          resource_id: RESENA,
        }),
      });
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          user_id: PATIENT,
          type: 'RESENA_MODERADA',
          payload: {
            professional: 'Ana García',
            decision: 'APROBADA',
            reason: null,
          },
        }),
      });
      expect(view).toMatchObject({
        professional: { id: PRO, name: 'Ana García' },
      });
    });

    it('una reseña ya moderada da 409', async () => {
      prisma.review.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.moderate(MOD, RESENA, {
          decision: 'RECHAZADA',
          reason: 'Insultos',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('una reseña inexistente da 404', async () => {
      prisma.review.updateMany.mockResolvedValue({ count: 0 });
      prisma.review.findUnique.mockResolvedValue(null);
      await expect(
        service.moderate(MOD, RESENA, { decision: 'APROBADA' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('si el aviso falla, la moderación igual queda hecha', async () => {
      prisma.notification.create.mockRejectedValue(new Error('db'));
      await expect(
        service.moderate(MOD, RESENA, { decision: 'APROBADA' }),
      ).resolves.toMatchObject({ id: RESENA });
    });

    it('un paciente no puede moderar', async () => {
      prisma.profile.findUnique.mockResolvedValue({ role: 'PACIENTE' });
      await expect(
        service.moderate(PATIENT, RESENA, { decision: 'APROBADA' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.review.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('filtro de lenguaje (ENG-107)', () => {
    it('un comentario con insultos no se guarda ni llega a la cola: se pide reformularlo', async () => {
      await expect(
        service.create(PATIENT, TURNO, {
          rating: 1,
          comment: 'Es un pelotudo',
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it('una crítica dura sin insultos pasa a la moderación como cualquier otra', async () => {
      await service.create(PATIENT, TURNO, {
        rating: 1,
        comment: 'Llegó tarde y fue maleducado. No lo recomiendo.',
      });

      expect(prisma.review.create).toHaveBeenCalled();
    });

    it('solo estrellas, sin comentario, no pasa por el filtro', async () => {
      await service.create(PATIENT, TURNO, { rating: 4 });

      expect(prisma.review.create).toHaveBeenCalled();
    });
  });

  describe('respuestas del profesional (ENG-106)', () => {
    beforeEach(() => {
      prisma.profile.findUnique.mockResolvedValue({ role: 'PROFESIONAL' });
      prisma.review.findUnique.mockResolvedValue({
        professional_id: PRO,
        status: 'APROBADA',
      });
    });

    it('responde una reseña publicada propia y lo deja en la auditoría', async () => {
      const now = new Date('2026-11-04T12:00:00.000Z');

      const res = await service.respond(
        PRO,
        RESENA,
        'Gracias por la devolución.',
        now,
      );

      expect(prisma.reviewResponse.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { review_id: RESENA },
          create: {
            review_id: RESENA,
            professional_id: PRO,
            content: 'Gracias por la devolución.',
            created_at: now,
          },
          update: { content: 'Gracias por la devolución.' },
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: PRO,
          action: 'REVIEW_RESPONSE_SAVED',
          resource_id: RESENA,
          metadata: {
            length: 26,
            previousContent: 'Versión vieja.',
          },
        }),
      });
      expect(res).toEqual({
        reviewId: RESENA,
        content: 'Gracias por la devolución.',
        createdAt: CREATED.toISOString(),
      });
    });

    it('una reseña de otro profesional da 404, sin decir que existe', async () => {
      prisma.review.findUnique.mockResolvedValue({
        professional_id: MOD,
        status: 'APROBADA',
      });

      await expect(service.respond(PRO, RESENA, 'Hola')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.reviewResponse.upsert).not.toHaveBeenCalled();
    });

    it('una reseña que todavía no se publicó no se responde', async () => {
      prisma.review.findUnique.mockResolvedValue({
        professional_id: PRO,
        status: 'PENDIENTE_MODERACION',
      });

      await expect(service.respond(PRO, RESENA, 'Hola')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('una respuesta con insultos pasa por el mismo filtro y no se guarda', async () => {
      await expect(
        service.respond(PRO, RESENA, 'Sos un forro, nunca fuiste'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.reviewResponse.upsert).not.toHaveBeenCalled();
    });

    it.each([
      'Escribime a https://mi-clinica.com',
      'Mirá www.clinica.com.ar',
      'Mi mail es dr@clinica.com',
      'Llamame al 11 5555-1234',
      'WhatsApp +54 9 11 5555 1234',
    ])('una respuesta con datos de contacto (%s) no se guarda', async (txt) => {
      await expect(service.respond(PRO, RESENA, txt)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.reviewResponse.upsert).not.toHaveBeenCalled();
    });

    it('el filtro no se evade con caracteres invisibles', async () => {
      await expect(
        service.respond(PRO, RESENA, 'Sos un fo\u200Brro'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('si falla la auditoría, la respuesta no queda guardada aparte', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('db'));
      await expect(service.respond(PRO, RESENA, 'Hola')).rejects.toThrow('db');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('solo responde un profesional', async () => {
      prisma.profile.findUnique.mockResolvedValue({ role: 'PACIENTE' });

      await expect(
        service.respond(PATIENT, RESENA, 'Hola'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.listReceived(PATIENT, 1)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('borra solo su propia respuesta, y sin respuesta da 404', async () => {
      await service.deleteResponse(PRO, RESENA);
      expect(prisma.reviewResponse.deleteMany).toHaveBeenCalledWith({
        where: { review_id: RESENA, professional_id: PRO },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'REVIEW_RESPONSE_DELETED' }),
      });

      prisma.reviewResponse.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.deleteResponse(PRO, RESENA)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('las recibidas son las publicadas de su perfil, con las respuestas', async () => {
      await service.listReceived(PRO, 1);

      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { professional_id: PRO, status: 'APROBADA' },
        }),
      );
    });
  });
});
