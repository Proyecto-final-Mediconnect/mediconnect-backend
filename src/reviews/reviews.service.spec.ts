import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ReviewsService, shortName } from './reviews.service';

/** ENG-80 y ENG-82: dejar reseñas, que se publican en el acto, y mostrarlas. */

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const OTRO_PRO = '33333333-3333-4333-8333-333333333333';
const TURNO = '44444444-4444-4444-8444-444444444444';
const RESENA = '55555555-5555-4555-8555-555555555555';
const CREATED = new Date('2026-11-01T15:00:00.000Z');

const FILA_PROPIA = {
  id: RESENA,
  appointment_id: TURNO,
  professional_id: PRO,
  rating: 5,
  comment: 'Muy clara.',
  status: 'APROBADA' as const,
  moderation_reason: null,
  created_at: CREATED,
};

describe('ReviewsService', () => {
  let service: ReviewsService;
  let prisma: {
    appointment: { findUnique: jest.Mock };
    review: {
      create: jest.Mock;
      findMany: jest.Mock;
      groupBy: jest.Mock;
      findUnique: jest.Mock;
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
        findUnique: jest.fn().mockResolvedValue({ id: RESENA }),
      },
      profile: {
        findUnique: jest.fn().mockResolvedValue({ role: 'PROFESIONAL' }),
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
    };
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(prisma),
    );
    service = new ReviewsService(prisma as unknown as PrismaService);
  });

  describe('create (ENG-80)', () => {
    it('deja la reseña de una consulta propia y terminada, ya publicada', async () => {
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
            status: 'APROBADA',
          },
        }),
      );
      expect(view).toMatchObject({ status: 'APROBADA', rating: 5 });
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

    describe('ENG-190: consulta en marcha sin completar', () => {
      const AHORA = new Date('2026-11-20T15:20:00Z');
      const turno = (over: Record<string, unknown> = {}) => ({
        patient_id: PATIENT,
        professional_id: PRO,
        status: 'CONFIRMADO',
        scheduled_at: new Date('2026-11-20T15:00:00Z'),
        review: null,
        consultation: {
          patient_joined_at: new Date('2026-11-20T15:01:00Z'),
          professional_joined_at: new Date('2026-11-20T14:58:00Z'),
        },
        ...over,
      });

      it('entraron los dos y ya es la hora: se puede reseñar', async () => {
        prisma.appointment.findUnique.mockResolvedValue(turno());
        await service.create(PATIENT, TURNO, { rating: 5 }, AHORA);
        expect(prisma.review.create).toHaveBeenCalled();
      });

      it('el profesional no entró: no se reseña (review de #114)', async () => {
        prisma.appointment.findUnique.mockResolvedValue(
          turno({
            consultation: {
              patient_joined_at: new Date('2026-11-20T15:01:00Z'),
              professional_joined_at: null,
            },
          }),
        );
        await expect(
          service.create(PATIENT, TURNO, { rating: 4 }, AHORA),
        ).rejects.toThrow('Solo se puede reseñar una consulta que ya se hizo.');
      });

      it('antes de la hora del turno no se reseña aunque hayan entrado', async () => {
        prisma.appointment.findUnique.mockResolvedValue(turno());
        await expect(
          service.create(
            PATIENT,
            TURNO,
            { rating: 4 },
            new Date('2026-11-20T14:55:00Z'),
          ),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('el paciente no entró: no se reseña', async () => {
        prisma.appointment.findUnique.mockResolvedValue(
          turno({
            consultation: {
              patient_joined_at: null,
              professional_joined_at: new Date(),
            },
          }),
        );
        await expect(
          service.create(PATIENT, TURNO, { rating: 4 }, AHORA),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('NO_ASISTIO no se reseña aunque haya consulta', async () => {
        prisma.appointment.findUnique.mockResolvedValue(
          turno({ status: 'NO_ASISTIO' }),
        );
        await expect(
          service.create(PATIENT, TURNO, { rating: 4 }, AHORA),
        ).rejects.toBeInstanceOf(ConflictException);
      });
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

  describe('filtro de lenguaje (ENG-107)', () => {
    it('un comentario con insultos no se guarda ni se publica: se pide reformularlo', async () => {
      await expect(
        service.create(PATIENT, TURNO, {
          rating: 1,
          comment: 'Es un pelotudo',
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it.each([
      'Llamame al 11 5555-1234 y te cuento',
      'Escribime a paciente@mail.com',
      'Mirá https://spam.example.com',
    ])(
      'un comentario con datos de contacto ("%s") no se guarda: se pide reformularlo',
      async (comment) => {
        await expect(
          service.create(PATIENT, TURNO, { rating: 3, comment }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(prisma.review.create).not.toHaveBeenCalled();
      },
    );

    it('una crítica dura sin insultos se publica como cualquier otra', async () => {
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
        professional_id: OTRO_PRO,
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
