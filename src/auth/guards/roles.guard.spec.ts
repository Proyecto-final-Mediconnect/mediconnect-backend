import {
  ExecutionContext,
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PrismaService } from '../../prisma/prisma.service';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

/** ENG-240 — el rol se lee de `profiles` y el guard falla cerrado. */
describe('RolesGuard', () => {
  const findUnique = jest.fn();
  const prisma = { profile: { findUnique } } as unknown as PrismaService;

  function contextWith(roles: string[] | undefined, userId?: string) {
    const handler = () => undefined;
    class Controller {}
    if (roles) Reflect.defineMetadata(ROLES_KEY, roles, handler);
    return {
      getHandler: () => handler,
      getClass: () => Controller,
      switchToHttp: () => ({
        getRequest: () => ({ user: userId ? { id: userId } : undefined }),
      }),
    } as unknown as ExecutionContext;
  }

  const guard = new RolesGuard(new Reflector(), prisma);

  beforeEach(() => {
    findUnique.mockReset();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('deja pasar al rol permitido, leído de profiles', async () => {
    findUnique.mockResolvedValue({ role: 'ADMINISTRADOR', deleted_at: null });

    await expect(
      guard.canActivate(contextWith(['ADMINISTRADOR'], 'u1')),
    ).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { role: true, deleted_at: true },
    });
  });

  it.each(['PACIENTE', 'PROFESIONAL'])('a un %s le da 403', async (role) => {
    findUnique.mockResolvedValue({ role, deleted_at: null });

    await expect(
      guard.canActivate(contextWith(['ADMINISTRADOR'], 'u1')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un perfil borrado o inexistente no pasa', async () => {
    findUnique.mockResolvedValueOnce({
      role: 'ADMINISTRADOR',
      deleted_at: new Date(),
    });
    await expect(
      guard.canActivate(contextWith(['ADMINISTRADOR'], 'u1')),
    ).rejects.toBeInstanceOf(ForbiddenException);

    findUnique.mockResolvedValueOnce(null);
    await expect(
      guard.canActivate(contextWith(['ADMINISTRADOR'], 'u1')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin @Roles no deja pasar a nadie, ni mira la base', async () => {
    await expect(
      guard.canActivate(contextWith(undefined, 'u1')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('sin sesión verificada da 401', async () => {
    await expect(
      guard.canActivate(contextWith(['ADMINISTRADOR'])),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
