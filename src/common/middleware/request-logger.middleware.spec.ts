import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequestLoggerMiddleware } from './request-logger.middleware';

function asRequest(partial: Record<string, unknown>): Request {
  return partial as unknown as Request;
}

function asResponse(partial: Record<string, unknown>): Response {
  return partial as unknown as Response;
}

describe('RequestLoggerMiddleware', () => {
  let middleware: RequestLoggerMiddleware;
  let logSpy: jest.SpyInstance;

  function makeResponse(): {
    on: jest.Mock;
    statusCode: number;
    fire: () => void;
  } {
    let finishCallback: (() => void) | undefined;
    return {
      statusCode: 200,
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'finish') finishCallback = cb;
      }),
      fire: () => finishCallback?.(),
    };
  }

  beforeEach(() => {
    middleware = new RequestLoggerMiddleware();
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('loguea método, path, status y el id del usuario autenticado', () => {
    const req = asRequest({
      method: 'GET',
      originalUrl: '/auth/me',
      user: {
        id: 'user-id-123',
        email: 'paciente@test.com',
        role: 'authenticated',
      },
    });
    const res = makeResponse();
    const next = jest.fn();

    middleware.use(req, asResponse(res), next);
    expect(next).toHaveBeenCalled();

    res.statusCode = 200;
    res.fire();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0] as [string];
    expect(message).toContain('GET /auth/me 200');
    expect(message).toContain('user=user-id-123');
    expect(message).not.toContain('paciente@test.com');
  });

  it('loguea user=anon cuando no hay usuario autenticado', () => {
    const req = asRequest({ method: 'POST', originalUrl: '/auth/login' });
    const res = makeResponse();
    res.statusCode = 401;

    middleware.use(req, asResponse(res), jest.fn());
    res.fire();

    const [message] = logSpy.mock.calls[0] as [string];
    expect(message).toContain('POST /auth/login 401');
    expect(message).toContain('user=anon');
  });

  it('nunca loguea el body del request (passwords, tokens)', () => {
    const req = asRequest({
      method: 'POST',
      originalUrl: '/auth/login',
      body: { email: 'x@test.com', password: 'super-secreta' },
      headers: { authorization: 'Bearer some-token' },
    });
    const res = makeResponse();
    res.statusCode = 200;

    middleware.use(req, asResponse(res), jest.fn());
    res.fire();

    const [message] = logSpy.mock.calls[0] as [string];
    expect(message).not.toContain('super-secreta');
    expect(message).not.toContain('some-token');
  });
});
