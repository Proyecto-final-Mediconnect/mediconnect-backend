import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { LEGAL_NOT_ACCEPTED_MESSAGE, LEGAL_VERSION } from './legal';
import {
  LEGAL_NOT_ACCEPTED_CODE,
  LegalAcceptedGuard,
} from './legal-accepted.guard';
import { SkipLegal } from './skip-legal.decorator';

class Guarded {
  handler() {}
}

@SkipLegal()
class SkippedController {
  handler() {}
}

class SkippedHandler {
  @SkipLegal()
  handler() {}
}

function makeContext(
  target: new () => { handler: () => void },
  request: object,
): ExecutionContext {
  return {
    getHandler: () => (target.prototype as { handler: () => void }).handler,
    getClass: () => target,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('LegalAcceptedGuard', () => {
  const findUnique = jest.fn();
  const prisma = {
    legalAcceptance: { findUnique },
  } as unknown as PrismaService;
  const guard = new LegalAcceptedGuard(new Reflector(), prisma);
  const request = { user: { id: 'user-1' } };

  beforeEach(() => findUnique.mockReset());

  it('deja pasar si el usuario aceptó la versión vigente', async () => {
    findUnique.mockResolvedValue({ id: 'acc-1' });

    await expect(
      guard.canActivate(makeContext(Guarded, request)),
    ).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        profile_id_version: { profile_id: 'user-1', version: LEGAL_VERSION },
      },
      select: { id: true },
    });
  });

  it('responde 403 LEGAL_NOT_ACCEPTED si no aceptó la versión vigente', async () => {
    findUnique.mockResolvedValue(null);

    const error = await guard
      .canActivate(makeContext(Guarded, request))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual({
      statusCode: 403,
      code: LEGAL_NOT_ACCEPTED_CODE,
      message: LEGAL_NOT_ACCEPTED_MESSAGE,
      legalVersion: LEGAL_VERSION,
    });
  });

  it('no consulta la base en un handler con @SkipLegal()', async () => {
    await expect(
      guard.canActivate(makeContext(SkippedHandler, request)),
    ).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('no consulta la base en un controller con @SkipLegal()', async () => {
    await expect(
      guard.canActivate(makeContext(SkippedController, request)),
    ).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('falla cerrado (401) si no hay usuario en el request', async () => {
    await expect(guard.canActivate(makeContext(Guarded, {}))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });
});
