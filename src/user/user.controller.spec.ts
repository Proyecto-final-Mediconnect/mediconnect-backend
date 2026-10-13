import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MeResponseDto } from './dto/me-response.dto';
import { UserController } from './user.controller';
import { LEGAL_VERSION } from '../legal/legal';
import { UserService } from './user.service';

describe('UserController', () => {
  let controller: UserController;
  const getProfile = jest.fn();
  const acceptLegal = jest.fn();

  const profile: MeResponseDto = {
    id: 'user-id-123',
    email: 'paciente@test.com',
    role: 'PACIENTE',
    firstName: 'Ana',
    lastName: 'García',
    legalAccepted: false,
    legalVersion: LEGAL_VERSION,
  };

  beforeEach(async () => {
    getProfile.mockReset();
    acceptLegal.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        { provide: UserService, useValue: { getProfile, acceptLegal } },
      ],
    })
      // El guard depende de SupabaseService; en el unit test del controller lo
      // reemplazamos por uno que siempre deja pasar (su lógica se prueba en
      // jwt-auth.guard.spec.ts y en el e2e de /me).
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(UserController);
  });

  const reqWith = (user: Request['user']) => ({ user }) as Request;

  it('devuelve el perfil leído por el service usando request.user.id', async () => {
    getProfile.mockResolvedValue(profile);

    const result = await controller.me(
      reqWith({
        id: 'user-id-123',
        email: 'paciente@test.com',
        role: 'authenticated',
      }),
    );

    expect(getProfile).toHaveBeenCalledWith('user-id-123');
    expect(result).toEqual(profile);
  });

  it('propaga 404 cuando el service no encuentra el perfil', async () => {
    getProfile.mockRejectedValue(new NotFoundException());

    await expect(
      controller.me(reqWith({ id: 'sin-perfil', role: 'authenticated' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('acepta los textos legales del usuario de la sesión (ENG-140)', async () => {
    acceptLegal.mockResolvedValue({ ...profile, legalAccepted: true });

    const result = await controller.acceptLegal(
      reqWith({ id: 'user-id-123', role: 'authenticated' }),
      { version: LEGAL_VERSION },
    );

    expect(acceptLegal).toHaveBeenCalledWith('user-id-123', LEGAL_VERSION);
    expect(result.legalAccepted).toBe(true);
  });
});
