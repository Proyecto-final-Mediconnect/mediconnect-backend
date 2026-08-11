import type { Breadcrumb, ErrorEvent } from '@sentry/nestjs';
import { scrubBreadcrumb, scrubEvent } from './sentry.scrubbing';

/** `ErrorEvent` se distingue del resto de los eventos por tener `type:
 *  undefined`; el helper evita repetirlo en cada caso. */
function buildEvent(partial: Partial<ErrorEvent>): ErrorEvent {
  return { type: undefined, ...partial };
}

describe('scrubEvent', () => {
  it('elimina el body del request', () => {
    const event = buildEvent({
      request: {
        url: 'https://api.mediconnect.ar/auth/register',
        method: 'POST',
        data: {
          email: 'paciente@example.com',
          password: 'secreto',
          dni: '12345678',
        },
      },
    });

    const result = scrubEvent(event);

    expect(result.request?.data).toBeUndefined();
  });

  it('elimina el header Authorization y las cookies', () => {
    const event = buildEvent({
      request: {
        url: 'https://api.mediconnect.ar/me',
        method: 'GET',
        headers: {
          authorization: 'Bearer un.jwt.cualquiera',
          host: 'api.mediconnect.ar',
        },
        cookies: { 'sb-access-token': 'un.jwt.cualquiera' },
      },
    });

    const result = scrubEvent(event);

    expect(result.request?.headers).toBeUndefined();
    expect(result.request?.cookies).toBeUndefined();
  });

  it('elimina el query string de la url y conserva la ruta', () => {
    const event = buildEvent({
      request: {
        url: 'https://api.mediconnect.ar/medipass?code=123456',
        method: 'GET',
        query_string: 'code=123456',
      },
    });

    const result = scrubEvent(event);

    expect(result.request?.url).toBe('https://api.mediconnect.ar/medipass');
    expect(result.request?.query_string).toBeUndefined();
  });

  it('conserva método y ruta, que son los que ubican el error', () => {
    const event = buildEvent({
      request: { url: 'https://api.mediconnect.ar/me', method: 'GET' },
    });

    const result = scrubEvent(event);

    expect(result.request?.url).toBe('https://api.mediconnect.ar/me');
    expect(result.request?.method).toBe('GET');
  });

  it('identifica al usuario por su id y descarta email, username e IP', () => {
    const event = buildEvent({
      user: {
        id: '3f1c0b6e-9b1a-4f7d-8c2e-5a6b7c8d9e0f',
        email: 'paciente@example.com',
        username: 'paciente',
        ip_address: '181.44.12.7',
      },
    });

    const result = scrubEvent(event);

    expect(result.user).toEqual({ id: '3f1c0b6e-9b1a-4f7d-8c2e-5a6b7c8d9e0f' });
  });

  it('no falla si el evento no trae request ni user', () => {
    const event = buildEvent({ message: 'boom' });

    expect(() => scrubEvent(event)).not.toThrow();
  });
});

describe('scrubBreadcrumb', () => {
  it('elimina el payload del breadcrumb', () => {
    const breadcrumb: Breadcrumb = {
      type: 'http',
      category: 'http',
      data: {
        url: 'https://api.mediconnect.ar/auth/login',
        body: { password: 'secreto' },
      },
    };

    const result = scrubBreadcrumb(breadcrumb);

    expect(result.data).toBeUndefined();
  });

  it('conserva la forma del breadcrumb para reconstruir la secuencia', () => {
    const breadcrumb: Breadcrumb = {
      type: 'http',
      category: 'http',
      level: 'error',
      message: 'request fallida',
    };

    const result = scrubBreadcrumb(breadcrumb);

    expect(result).toEqual({
      type: 'http',
      category: 'http',
      level: 'error',
      message: 'request fallida',
    });
  });
});
