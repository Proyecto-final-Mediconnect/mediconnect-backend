import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { UserService } from './user.service';

describe('UserService', () => {
  let service: UserService;
  const findUnique = jest.fn();

  beforeEach(async () => {
    findUnique.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: { profile: { findUnique } } },
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
    });

    await expect(service.getProfile('uid')).resolves.toEqual({
      id: 'uid',
      email: 'paciente@test.com',
      role: 'PACIENTE',
      firstName: 'Ana',
      lastName: 'García',
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
    });

    await expect(service.getProfile('uid')).resolves.toEqual({
      id: 'uid',
      email: 'mod@test.com',
      role: 'MODERADOR',
      firstName: null,
      lastName: null,
    });
  });

  it('lanza NotFoundException cuando no existe el perfil', async () => {
    findUnique.mockResolvedValue(null);

    await expect(service.getProfile('inexistente')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
