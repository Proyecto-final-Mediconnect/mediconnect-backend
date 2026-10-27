import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_CANCELLATION_POLICY } from './cancellation-policy';
import { PublicProfessionalsService } from './public-professionals.service';

describe('PublicProfessionalsService', () => {
  let service: PublicProfessionalsService;
  const findFirst = jest.fn();

  const ID = '11111111-1111-4111-8111-111111111111';

  const validatedRow = {
    profile_id: ID,
    first_name: 'Ana',
    last_name: 'García',
    bio: 'Cardióloga.',
    photo_url: 'https://cdn/ana.png',
    consultation_price: '15000.00',
    currency: 'ARS',
    specialties: [
      { specialty: { id: 's1', name: 'Cardiología' } },
      { specialty: { id: 's2', name: 'Clínica médica' } },
    ],
    education: [
      { id: 'e1', institution: 'UBA', degree: 'Médica', year: 2015 },
      { id: 'e2', institution: 'Hospital X', degree: 'Residencia', year: null },
    ],
    // ENG-67: la política viaja en el perfil público porque es lo que el
    // paciente necesita saber ANTES de reservar.
    cancellation_policy: {
      hours_full_refund: 48,
      hours_partial_refund: 12,
      partial_refund_percent: 30,
    },
  };

  beforeEach(async () => {
    findFirst.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublicProfessionalsService,
        { provide: PrismaService, useValue: { professional: { findFirst } } },
      ],
    }).compile();

    service = module.get(PublicProfessionalsService);
  });

  it('mapea el perfil público a camelCase con especialidades y formación', async () => {
    findFirst.mockResolvedValue(validatedRow);

    await expect(service.getPublicProfile(ID)).resolves.toEqual({
      id: ID,
      firstName: 'Ana',
      lastName: 'García',
      photoUrl: 'https://cdn/ana.png',
      bio: 'Cardióloga.',
      specialties: [
        { id: 's1', name: 'Cardiología' },
        { id: 's2', name: 'Clínica médica' },
      ],
      cancellationPolicy: {
        hoursFullRefund: 48,
        hoursPartialRefund: 12,
        partialRefundPercent: 30,
      },
      education: [
        { id: 'e1', institution: 'UBA', degree: 'Médica', year: 2015 },
        {
          id: 'e2',
          institution: 'Hospital X',
          degree: 'Residencia',
          year: null,
        },
      ],
      price: 15000,
      currency: 'ARS',
    });
  });

  it('solo pide profesionales con status VALIDADO', async () => {
    findFirst.mockResolvedValue(validatedRow);

    await service.getPublicProfile(ID);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { profile_id: ID, status: 'VALIDADO' },
      }),
    );
  });

  it('normaliza el precio Decimal a number y respeta null', async () => {
    findFirst.mockResolvedValue({ ...validatedRow, consultation_price: null });

    const result = await service.getPublicProfile(ID);
    expect(result.price).toBeNull();
  });

  it('lanza NotFoundException cuando no existe o no está validado', async () => {
    findFirst.mockResolvedValue(null);

    await expect(service.getPublicProfile(ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('política de cancelación (ENG-67)', () => {
    it('sin política configurada viaja el default, no null', async () => {
      // Un paciente que está por reservar tiene que ver a qué atenerse. "Sin
      // política" no es una respuesta frente a un turno que va a pagar.
      findFirst.mockResolvedValue({
        ...validatedRow,
        cancellation_policy: null,
      });

      await expect(service.getPublicProfile(ID)).resolves.toMatchObject({
        cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
      });
    });

    it('una política a medias también cae al default', async () => {
      // Las tres columnas son nullable en el esquema. Mezclar lo propio con el
      // default da una combinación que el profesional nunca eligió.
      findFirst.mockResolvedValue({
        ...validatedRow,
        cancellation_policy: {
          hours_full_refund: 48,
          hours_partial_refund: null,
          partial_refund_percent: 30,
        },
      });

      await expect(service.getPublicProfile(ID)).resolves.toMatchObject({
        cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
      });
    });

    it('no expone `configured`: al paciente no le dice nada', async () => {
      findFirst.mockResolvedValue(validatedRow);

      const perfil = await service.getPublicProfile(ID);

      expect(perfil.cancellationPolicy).not.toHaveProperty('configured');
    });
  });
});
