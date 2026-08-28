import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
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
});
