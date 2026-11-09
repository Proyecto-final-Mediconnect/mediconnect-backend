import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ReviewPromptsService } from './review-prompts.service';
import { REVIEWABLE_WHERE } from './reviewable';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const TURNO = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-20T18:00:00.000Z');

/** ENG-190 — reseñas pendientes y descarte del pedido. */
describe('ReviewPromptsService', () => {
  let prisma: {
    appointment: { findMany: jest.Mock; findUnique: jest.Mock };
    reviewPromptDismissal: { upsert: jest.Mock };
  };
  let service: ReviewPromptsService;

  beforeEach(() => {
    prisma = {
      appointment: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ patient_id: PATIENT }),
      },
      reviewPromptDismissal: { upsert: jest.fn().mockResolvedValue({}) },
    };
    service = new ReviewPromptsService(prisma as unknown as PrismaService);
  });

  describe('listPending', () => {
    it('pide los reseñables propios de los últimos 30 días, sin reseña ni descarte', async () => {
      await service.listPending(PATIENT, NOW);

      expect(prisma.appointment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            ...REVIEWABLE_WHERE,
            patient_id: PATIENT,
            scheduled_at: {
              gte: new Date('2026-10-21T18:00:00.000Z'),
              lte: NOW,
            },
            review: { is: null },
            review_prompt_dismissal: { is: null },
          },
        }),
      );
    });

    it('devuelve el turno con el profesional', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        {
          id: TURNO,
          scheduled_at: new Date('2026-11-20T15:00:00.000Z'),
          professional: {
            profile_id: OTHER,
            first_name: 'Ana',
            last_name: 'Gómez',
            photo_url: null,
          },
        },
      ]);

      await expect(service.listPending(PATIENT, NOW)).resolves.toEqual([
        {
          appointmentId: TURNO,
          scheduledAt: '2026-11-20T15:00:00.000Z',
          professional: {
            id: OTHER,
            firstName: 'Ana',
            lastName: 'Gómez',
            photoUrl: null,
          },
        },
      ]);
    });
  });

  describe('dismiss', () => {
    it('guarda el descarte de un turno propio, sin duplicar', async () => {
      await service.dismiss(PATIENT, TURNO);

      expect(prisma.reviewPromptDismissal.upsert).toHaveBeenCalledWith({
        where: { appointment_id: TURNO },
        create: { patient_id: PATIENT, appointment_id: TURNO },
        update: {},
      });
    });

    it('un turno ajeno da 404 y no guarda nada', async () => {
      prisma.appointment.findUnique.mockResolvedValue({ patient_id: OTHER });

      await expect(service.dismiss(PATIENT, TURNO)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.reviewPromptDismissal.upsert).not.toHaveBeenCalled();
    });

    it('un turno inexistente da 404', async () => {
      prisma.appointment.findUnique.mockResolvedValue(null);
      await expect(service.dismiss(PATIENT, TURNO)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
