import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { LEGAL_VERSION } from '../legal/legal';
import { UserService } from './user.service';

describe('UserService', () => {
  let service: UserService;
  const findUnique = jest.fn();
  const createMany = jest.fn();

  beforeEach(async () => {
    findUnique.mockReset();
    createMany.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: PrismaService,
          useValue: {
            profile: { findUnique },
            legalAcceptance: { createMany },
          },
        },
      ],
    }).compile();

    service = module.get(UserService);
  });

  it('mapea el perfil de paciente a MeResponseDto (nombre desde patients)', async () => {
    findUnique.mockResolvedValue({
      id: 'uid',
      email: 'paciente@test.com',
      role: 'PACIENTE',
      patient: { first_name: 'Ana', last_name: 'García' },
      professional: null,
      legal_acceptances: [],
    });

    await expect(service.getProfile('uid')).resolves.toEqual({
      id: 'uid',
      email: 'paciente@test.com',
      role: 'PACIENTE',
      firstName: 'Ana',
      lastName: 'García',
      legalAccepted: false,
      legalVersion: LEGAL_VERSION,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'uid' },
      select: expect.objectContaining({ role: true }),
    });
  });

  it('toma el nombre de professionals cuando no hay paciente', async () => {
    findUnique.mockResolvedValue({
      id: 'uid',
      email: 'pro@test.com',
      role: 'PROFESIONAL',
      patient: null,
      professional: { first_name: 'Carlos', last_name: 'Ruiz' },
      legal_acceptances: [],
    });

    const result = await service.getProfile('uid');
    expect(result.role).toBe('PROFESIONAL');
    expect(result.firstName).toBe('Carlos');
    expect(result.lastName).toBe('Ruiz');
  });

  it('devuelve nombre null para un perfil sin fila asociada (ej. MODERADOR)', async () => {
    findUnique.mockResolvedValue({
      id: 'uid',
      email: 'mod@test.com',
      role: 'MODERADOR',
      patient: null,
      professional: null,
      legal_acceptances: [],
    });

    await expect(service.getProfile('uid')).resolves.toEqual({
      id: 'uid',
      email: 'mod@test.com',
      role: 'MODERADOR',
      firstName: null,
      lastName: null,
      legalAccepted: false,
      legalVersion: LEGAL_VERSION,
    });
  });

  it('lanza NotFoundException cuando no existe el perfil', async () => {
    findUnique.mockResolvedValue(null);

    await expect(service.getProfile('inexistente')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('aceptación legal (ENG-140)', () => {
    const fila = (legal_acceptances: { id: string }[]) => ({
      id: 'uid',
      email: 'paciente@test.com',
      role: 'PACIENTE',
      patient: { first_name: 'Ana', last_name: 'García' },
      professional: null,
      legal_acceptances,
    });

    it('informa que aceptó cuando hay una fila de la versión vigente', async () => {
      findUnique.mockResolvedValue(fila([{ id: 'acc-1' }]));

      const result = await service.getProfile('uid');

      expect(result.legalAccepted).toBe(true);
      expect(result.legalVersion).toBe(LEGAL_VERSION);
    });

    it('solo busca aceptaciones de la versión vigente', async () => {
      // Una aceptación de una versión vieja no cuenta: cuando cambian los
      // textos, se vuelven a pedir.
      findUnique.mockResolvedValue(fila([]));

      const result = await service.getProfile('uid');

      expect(result.legalAccepted).toBe(false);
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            legal_acceptances: expect.objectContaining({
              where: { version: LEGAL_VERSION },
            }),
          }),
        }),
      );
    });

    it('acceptLegal guarda la versión vigente sin duplicar y devuelve el perfil', async () => {
      createMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue(fila([{ id: 'acc-1' }]));

      const result = await service.acceptLegal('uid', LEGAL_VERSION);

      expect(createMany).toHaveBeenCalledWith({
        data: [{ profile_id: 'uid', version: LEGAL_VERSION }],
        skipDuplicates: true,
      });
      expect(result.legalAccepted).toBe(true);
    });
  });
});
