import {
  ExecutionContext,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobSecretGuard } from './job-secret.guard';

const SECRET = 'x'.repeat(40);

function contextWith(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(secret: string | undefined): JobSecretGuard {
  return new JobSecretGuard({
    get: () => secret,
  } as unknown as ConfigService);
}

describe('JobSecretGuard', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('deja pasar con el secreto correcto', () => {
    expect(guardWith(SECRET).canActivate(contextWith(`Bearer ${SECRET}`))).toBe(
      true,
    );
  });

  it.each([
    ['sin header', undefined],
    ['con otro secreto', `Bearer ${'y'.repeat(40)}`],
    ['con un prefijo del secreto', `Bearer ${SECRET.slice(0, 10)}`],
    ['sin el esquema Bearer', SECRET],
  ])('rechaza %s', (_caso, header) => {
    expect(() => guardWith(SECRET).canActivate(contextWith(header))).toThrow(
      UnauthorizedException,
    );
  });

  it('sin JOBS_SECRET configurado los jobs quedan apagados, no abiertos', () => {
    // Si un deploy se olvida la variable, nadie puede disparar los jobs:
    // ni siquiera con un header vacío que "coincida" con el secreto vacío.
    expect(() =>
      guardWith(undefined).canActivate(contextWith('Bearer ')),
    ).toThrow(ServiceUnavailableException);
  });
});
