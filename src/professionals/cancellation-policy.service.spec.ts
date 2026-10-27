import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_CANCELLATION_POLICY } from './cancellation-policy';
import { CancellationPolicyService } from './cancellation-policy.service';
import { UpdateCancellationPolicyDto } from './dto/update-cancellation-policy.dto';

/**
 * CRUD de la política de cancelación (ENG-67).
 *
 * Lo que se verifica acá es que el default no se materialice como fila, que la
 * relación entre los dos plazos se valide —porque un decorador por campo no
 * puede verla— y que un paciente no llegue a configurar nada.
 */

const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';

function dto(overrides: Partial<UpdateCancellationPolicyDto> = {}) {
  return {
    hoursFullRefund: 48,
    hoursPartialRefund: 12,
    partialRefundPercent: 30,
    ...overrides,
  };
}

describe('CancellationPolicyService', () => {
  let service: CancellationPolicyService;
  let prisma: {
    professional: { findUnique: jest.Mock };
    cancellationPolicy: { findUnique: jest.Mock; upsert: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      professional: {
        findUnique: jest.fn().mockResolvedValue({ profile_id: PROFESSIONAL }),
      },
      cancellationPolicy: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    service = new CancellationPolicyService(prisma as unknown as PrismaService);
  });

  describe('getMyPolicy', () => {
    it('sin política configurada devuelve el default', async () => {
      await expect(service.getMyPolicy(PROFESSIONAL)).resolves.toEqual({
        ...DEFAULT_CANCELLATION_POLICY,
        configured: false,
      });
    });

    it('NO crea la fila al leer', async () => {
      // Un GET que escribe deja filas de profesionales que solo abrieron la
      // pantalla, y entonces `configured` deja de distinguir nada.
      await service.getMyPolicy(PROFESSIONAL);

      expect(prisma.cancellationPolicy.upsert).not.toHaveBeenCalled();
    });

    it('con política configurada devuelve la del profesional', async () => {
      prisma.cancellationPolicy.findUnique.mockResolvedValue({
        hours_full_refund: 72,
        hours_partial_refund: 24,
        partial_refund_percent: 25,
      });

      await expect(service.getMyPolicy(PROFESSIONAL)).resolves.toEqual({
        hoursFullRefund: 72,
        hoursPartialRefund: 24,
        partialRefundPercent: 25,
        configured: true,
      });
    });

    it('un usuario sin fila de profesional recibe 409', async () => {
      prisma.professional.findUnique.mockResolvedValue(null);

      await expect(service.getMyPolicy(PROFESSIONAL)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.cancellationPolicy.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('replaceMyPolicy', () => {
    it('guarda los tres valores y los devuelve como configurados', async () => {
      await expect(
        service.replaceMyPolicy(PROFESSIONAL, dto()),
      ).resolves.toEqual({
        hoursFullRefund: 48,
        hoursPartialRefund: 12,
        partialRefundPercent: 30,
        configured: true,
      });

      expect(prisma.cancellationPolicy.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { professional_id: PROFESSIONAL },
          create: expect.objectContaining({
            professional_id: PROFESSIONAL,
            hours_full_refund: 48,
            hours_partial_refund: 12,
            partial_refund_percent: 30,
          }),
        }),
      );
    });

    it('rechaza la ventana parcial más lejos que la total, sin escribir', async () => {
      // Es lo que un `@Min`/`@Max` por campo no puede ver.
      await expect(
        service.replaceMyPolicy(
          PROFESSIONAL,
          dto({ hoursFullRefund: 6, hoursPartialRefund: 24 }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.cancellationPolicy.upsert).not.toHaveBeenCalled();
    });

    it('acepta las dos ventanas iguales', async () => {
      await expect(
        service.replaceMyPolicy(
          PROFESSIONAL,
          dto({ hoursFullRefund: 24, hoursPartialRefund: 24 }),
        ),
      ).resolves.toMatchObject({ configured: true });
    });

    it('un paciente no puede configurar una política', async () => {
      prisma.professional.findUnique.mockResolvedValue(null);

      await expect(
        service.replaceMyPolicy(PROFESSIONAL, dto()),
      ).rejects.toThrow(ConflictException);
      expect(prisma.cancellationPolicy.upsert).not.toHaveBeenCalled();
    });

    it('un error de la base no sale como el error crudo de Prisma', async () => {
      prisma.cancellationPolicy.upsert.mockRejectedValue(
        new Error('base caída'),
      );

      await expect(
        service.replaceMyPolicy(PROFESSIONAL, dto()),
      ).rejects.toThrow(/No pudimos guardar la política/);
    });
  });

  describe('policyFor (perfil público)', () => {
    it('devuelve el default cuando el profesional no la configuró', async () => {
      // Nunca `null`: un paciente que está por reservar tiene que ver a qué
      // atenerse, y "sin política" no es una respuesta frente a un turno que va
      // a pagar.
      await expect(service.policyFor(PROFESSIONAL)).resolves.toEqual(
        DEFAULT_CANCELLATION_POLICY,
      );
    });

    it('no exige que el profesional exista: es una lectura de perfil', async () => {
      prisma.professional.findUnique.mockResolvedValue(null);

      await expect(service.policyFor(PROFESSIONAL)).resolves.toBeDefined();
    });

    it('no incluye `configured`: al paciente no le dice nada', async () => {
      const policy = await service.policyFor(PROFESSIONAL);

      expect(policy).not.toHaveProperty('configured');
    });
  });
});
