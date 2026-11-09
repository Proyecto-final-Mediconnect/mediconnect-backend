import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { MfaService } from './mfa.service';

/** Verificación en dos pasos (ENG-88), contra la API de Supabase Auth mockeada. */

const AUTH = 'https://proyecto.supabase.co/auth/v1';
const USER = '11111111-1111-4111-8111-111111111111';
const FACTOR = '22222222-2222-4222-8222-222222222222';

function ok(body: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}
function fail(status: number): Response {
  return { ok: false, status, text: () => Promise.resolve('') } as Response;
}

const SESION_AAL2 = {
  access_token: 'acc-aal2',
  refresh_token: 'ref-aal2',
  user: { id: USER, email: 'ana@test.com' },
};

describe('MfaService', () => {
  let service: MfaService;
  let fetchMock: jest.Mock;
  let prisma: {
    profile: { update: jest.Mock };
    auditLog: { create: jest.Mock };
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    prisma = {
      profile: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    service = new MfaService(
      { getIssuer: () => AUTH } as unknown as SupabaseService,
      { getOrThrow: () => 'anon-key' } as unknown as ConfigService,
      prisma as unknown as PrismaService,
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** Lo que se le pidió a Supabase, en orden: método y ruta. */
  const llamadas = () =>
    fetchMock.mock.calls.map(
      ([url, init]: [string, RequestInit]) =>
        `${init.method} ${url.replace(AUTH, '')}`,
    );

  it('cada llamada va con el token de la persona y la anon key', async () => {
    fetchMock.mockResolvedValue(ok({ factors: [] }));

    await service.isEnabled('token-del-usuario');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      apikey: 'anon-key',
      Authorization: 'Bearer token-del-usuario',
    });
  });

  it('está activa solo con un factor TOTP verificado', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ factors: [{ id: 'a', factor_type: 'totp', status: 'unverified' }] }),
    );
    await expect(service.isEnabled('t')).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(
      ok({ factors: [{ id: 'b', factor_type: 'totp', status: 'verified' }] }),
    );
    await expect(service.isEnabled('t')).resolves.toBe(true);
  });

  describe('alta', () => {
    it('borra un intento a medias y devuelve el QR y la clave', async () => {
      fetchMock
        .mockResolvedValueOnce(
          ok({
            factors: [
              { id: 'viejo', factor_type: 'totp', status: 'unverified' },
            ],
          }),
        )
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(
          ok({
            id: FACTOR,
            totp: {
              qr_code: 'data:image/svg+xml;utf-8,<svg/>',
              secret: 'ABC123',
            },
          }),
        );

      const alta = await service.startEnrollment(USER, 't');

      expect(llamadas()).toEqual([
        'GET /user',
        'DELETE /factors/viejo',
        'POST /factors',
      ]);
      const body = JSON.parse(
        (fetchMock.mock.calls[2] as [string, RequestInit])[1].body as string,
      );
      expect(body).toMatchObject({
        factor_type: 'totp',
        issuer: 'MediConnect',
      });
      expect(alta).toEqual({
        factorId: FACTOR,
        qr: 'data:image/svg+xml;utf-8,<svg/>',
        secret: 'ABC123',
      });
    });

    it('si ya está activa, no crea otro factor', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({ factors: [{ id: 'x', factor_type: 'totp', status: 'verified' }] }),
      );

      await expect(service.startEnrollment(USER, 't')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('si el factor quedó verificado sin el perfil, lo corrige antes del 409', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({ factors: [{ id: 'x', factor_type: 'totp', status: 'verified' }] }),
      );

      await expect(service.startEnrollment(USER, 't')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.profile.update).toHaveBeenCalledWith({
        where: { id: USER },
        data: { mfa_enabled: true },
      });
    });

    it('solo borra factores TOTP sin verificar', async () => {
      fetchMock
        .mockResolvedValueOnce(
          ok({
            factors: [
              { id: 'tel', factor_type: 'phone', status: 'unverified' },
              { id: 'viejo', factor_type: 'totp', status: 'unverified' },
            ],
          }),
        )
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(
          ok({ id: FACTOR, totp: { qr_code: 'qr', secret: 's' } }),
        );

      await service.startEnrollment(USER, 't');

      expect(llamadas()).toEqual([
        'GET /user',
        'DELETE /factors/viejo',
        'POST /factors',
      ]);
    });

    it('si falla guardar el perfil tras verificar, da 503 y se puede reintentar', async () => {
      prisma.profile.update.mockRejectedValueOnce(new Error('db'));
      fetchMock
        .mockResolvedValueOnce(ok({ id: 'challenge-1' }))
        .mockResolvedValueOnce(ok(SESION_AAL2));

      await expect(
        service.confirmEnrollment(USER, 't', FACTOR, '123456'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();

      // El reintento con otro código verifica el mismo factor (ya verificado
      // en Supabase) y esta vez guarda el perfil.
      fetchMock
        .mockResolvedValueOnce(ok({ id: 'challenge-2' }))
        .mockResolvedValueOnce(ok(SESION_AAL2));
      await expect(
        service.confirmEnrollment(USER, 't', FACTOR, '654321'),
      ).resolves.toMatchObject({ accessToken: 'acc-aal2' });
      expect(prisma.profile.update).toHaveBeenLastCalledWith({
        where: { id: USER },
        data: { mfa_enabled: true },
      });
    });

    it('un fallo al auditar la activación no la convierte en error', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('db'));
      fetchMock
        .mockResolvedValueOnce(ok({ id: 'challenge-1' }))
        .mockResolvedValueOnce(ok(SESION_AAL2));

      await expect(
        service.confirmEnrollment(USER, 't', FACTOR, '123456'),
      ).resolves.toMatchObject({ accessToken: 'acc-aal2' });
    });

    it('al confirmar con el código, la deja activa en el perfil y en la auditoría', async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ id: 'challenge-1' }))
        .mockResolvedValueOnce(ok(SESION_AAL2));

      const sesion = await service.confirmEnrollment(
        USER,
        't',
        FACTOR,
        '123456',
      );

      expect(llamadas()).toEqual([
        `POST /factors/${FACTOR}/challenge`,
        `POST /factors/${FACTOR}/verify`,
      ]);
      expect(
        JSON.parse(
          (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
        ),
      ).toEqual({
        challenge_id: 'challenge-1',
        code: '123456',
      });
      expect(prisma.profile.update).toHaveBeenCalledWith({
        where: { id: USER },
        data: { mfa_enabled: true },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: USER,
          action: 'MFA_ENABLED',
        }),
      });
      expect(sesion).toEqual({
        accessToken: 'acc-aal2',
        refreshToken: 'ref-aal2',
        user: { id: USER, email: 'ana@test.com' },
      });
    });

    it('un código equivocado no la activa y lo explica', async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ id: 'challenge-1' }))
        .mockResolvedValueOnce(fail(422));

      await expect(
        service.confirmEnrollment(USER, 't', FACTOR, '000000'),
      ).rejects.toThrow(/El código no es válido/);
      expect(prisma.profile.update).not.toHaveBeenCalled();
    });
  });

  describe('ingreso', () => {
    it('cambia el token del primer paso por la sesión completa', async () => {
      fetchMock
        .mockResolvedValueOnce(
          ok({
            factors: [{ id: FACTOR, factor_type: 'totp', status: 'verified' }],
          }),
        )
        .mockResolvedValueOnce(ok({ id: 'challenge-1' }))
        .mockResolvedValueOnce(ok(SESION_AAL2));

      await expect(
        service.verifyLogin('aal1', '123456'),
      ).resolves.toMatchObject({ accessToken: 'acc-aal2' });
    });

    it('un token del primer paso vencido da 401', async () => {
      fetchMock.mockResolvedValueOnce(fail(401));

      await expect(
        service.verifyLogin('vencido', '123456'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('si Supabase no responde es 503, no un código equivocado', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(service.verifyLogin('t', '123456')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('baja', () => {
    it('verifica el código, borra el factor con la sesión aal2 y la apaga en el perfil', async () => {
      fetchMock
        .mockResolvedValueOnce(
          ok({
            factors: [{ id: FACTOR, factor_type: 'totp', status: 'verified' }],
          }),
        )
        .mockResolvedValueOnce(ok({ id: 'challenge-1' }))
        .mockResolvedValueOnce(ok(SESION_AAL2))
        .mockResolvedValueOnce(ok());

      await service.disable(USER, 't', '123456');

      expect(llamadas().at(-1)).toBe(`DELETE /factors/${FACTOR}`);
      const [, borrar] = fetchMock.mock.calls[3] as [string, RequestInit];
      expect((borrar.headers as Record<string, string>).Authorization).toBe(
        'Bearer acc-aal2',
      );
      expect(prisma.profile.update).toHaveBeenCalledWith({
        where: { id: USER },
        data: { mfa_enabled: false },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'MFA_DISABLED' }),
      });
    });

    it('apaga el perfil antes de borrar el factor', async () => {
      fetchMock
        .mockResolvedValueOnce(
          ok({
            factors: [{ id: FACTOR, factor_type: 'totp', status: 'verified' }],
          }),
        )
        .mockResolvedValueOnce(ok({ id: 'challenge-1' }))
        .mockResolvedValueOnce(ok(SESION_AAL2))
        .mockResolvedValueOnce(ok());

      await service.disable(USER, 't', '123456');

      const update = prisma.profile.update.mock.invocationCallOrder[0];
      const borrar = fetchMock.mock.invocationCallOrder[3];
      expect(update).toBeLessThan(borrar);
    });

    it('si falla el borrado del factor, vuelve a activarla en el perfil', async () => {
      fetchMock
        .mockResolvedValueOnce(
          ok({
            factors: [{ id: FACTOR, factor_type: 'totp', status: 'verified' }],
          }),
        )
        .mockResolvedValueOnce(ok({ id: 'challenge-1' }))
        .mockResolvedValueOnce(ok(SESION_AAL2))
        .mockResolvedValueOnce(fail(500));

      await expect(service.disable(USER, 't', '123456')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      expect(prisma.profile.update).toHaveBeenLastCalledWith({
        where: { id: USER },
        data: { mfa_enabled: true },
      });
      expect(prisma.auditLog.create).not.toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'MFA_DISABLED' }),
      });
    });

    it('sin la verificación activa no hay nada que desactivar', async () => {
      fetchMock.mockResolvedValueOnce(ok({ factors: [] }));

      await expect(service.disable(USER, 't', '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('auditoría y bloqueo del segundo paso', () => {
    const conFactor = ok({
      id: USER,
      factors: [{ id: FACTOR, factor_type: 'totp', status: 'verified' }],
    });
    const acciones = () =>
      prisma.auditLog.create.mock.calls.map(
        ([a]: [{ data: { action: string } }]) => a.data.action,
      );

    it('audita el ingreso correcto', async () => {
      fetchMock
        .mockResolvedValueOnce(conFactor)
        .mockResolvedValueOnce(ok({ id: 'c' }))
        .mockResolvedValueOnce(ok(SESION_AAL2));

      await service.verifyLogin('tok', '123456');

      expect(acciones()).toEqual(['MFA_LOGIN_OK']);
    });

    it('audita cada código incorrecto y bloquea a la persona tras 5', async () => {
      for (let i = 0; i < 5; i++) {
        fetchMock
          .mockResolvedValueOnce(conFactor)
          .mockResolvedValueOnce(ok({ id: 'c' }))
          .mockResolvedValueOnce(fail(422));
        await expect(service.verifyLogin('tok', '000000')).rejects.toThrow(
          BadRequestException,
        );
      }
      expect(acciones()).toEqual([
        'MFA_LOGIN_FAILED',
        'MFA_LOGIN_FAILED',
        'MFA_LOGIN_FAILED',
        'MFA_LOGIN_FAILED',
        'MFA_LOGIN_LOCKED',
      ]);

      // Bloqueada: solo se consulta quién es, no se prueba el código.
      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(conFactor);
      await expect(service.verifyLogin('tok', '123456')).rejects.toMatchObject({
        status: 429,
      });
      expect(llamadas()).toEqual(['GET /user']);

      // Un login nuevo (otro token del primer paso) no reinicia el contador.
      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(conFactor);
      await expect(
        service.verifyLogin('token-de-otro-login', '123456'),
      ).rejects.toMatchObject({ status: 429 });
      expect(llamadas()).toEqual(['GET /user']);

      // Otra persona no se ve afectada.
      fetchMock
        .mockResolvedValueOnce(
          ok({
            id: 'otra-persona',
            factors: [{ id: FACTOR, factor_type: 'totp', status: 'verified' }],
          }),
        )
        .mockResolvedValueOnce(ok({ id: 'c' }))
        .mockResolvedValueOnce(ok(SESION_AAL2));
      await expect(
        service.verifyLogin('otro', '123456'),
      ).resolves.toBeDefined();
    });

    it('un ingreso correcto reinicia el contador de la persona', async () => {
      for (let i = 0; i < 4; i++) {
        fetchMock
          .mockResolvedValueOnce(conFactor)
          .mockResolvedValueOnce(ok({ id: 'c' }))
          .mockResolvedValueOnce(fail(422));
        await expect(service.verifyLogin('tok', '000000')).rejects.toThrow(
          BadRequestException,
        );
      }
      fetchMock
        .mockResolvedValueOnce(conFactor)
        .mockResolvedValueOnce(ok({ id: 'c' }))
        .mockResolvedValueOnce(ok(SESION_AAL2));
      await service.verifyLogin('tok', '123456');

      fetchMock
        .mockResolvedValueOnce(conFactor)
        .mockResolvedValueOnce(ok({ id: 'c' }))
        .mockResolvedValueOnce(fail(422));
      await expect(service.verifyLogin('tok', '000000')).rejects.toThrow(
        BadRequestException,
      );
      expect(acciones().at(-1)).toBe('MFA_LOGIN_FAILED');
    });

    it('deja en la auditoría la IP, el user-agent y el factor', async () => {
      fetchMock
        .mockResolvedValueOnce(conFactor)
        .mockResolvedValueOnce(ok({ id: 'c' }))
        .mockResolvedValueOnce(ok(SESION_AAL2));

      await service.verifyLogin('tok', '123456', {
        ip: '203.0.113.7',
        userAgent: 'MediConnect/1.0',
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'MFA_LOGIN_OK',
          metadata: {
            ip: '203.0.113.7',
            userAgent: 'MediConnect/1.0',
            factorId: FACTOR,
          },
        }),
      });
    });

    it('sin IP conocida no guarda la clave vacía', async () => {
      fetchMock
        .mockResolvedValueOnce(conFactor)
        .mockResolvedValueOnce(ok({ id: 'c' }))
        .mockResolvedValueOnce(ok(SESION_AAL2));

      await service.verifyLogin('tok', '123456', { ip: null, userAgent: null });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ metadata: { factorId: FACTOR } }),
      });
    });

    it('un fallo al auditar no tapa el error del código', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('db'));
      fetchMock
        .mockResolvedValueOnce(conFactor)
        .mockResolvedValueOnce(ok({ id: 'c' }))
        .mockResolvedValueOnce(fail(422));

      await expect(service.verifyLogin('tok2', '000000')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('un código incorrecto al desactivar queda auditado', async () => {
      fetchMock
        .mockResolvedValueOnce(conFactor)
        .mockResolvedValueOnce(ok({ id: 'c' }))
        .mockResolvedValueOnce(fail(422));

      await expect(service.disable(USER, 't', '000000')).rejects.toThrow(
        BadRequestException,
      );
      expect(acciones()).toEqual(['MFA_CODE_FAILED']);
      expect(prisma.profile.update).not.toHaveBeenCalled();
    });

    it('al empezar el alta queda auditado', async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ factors: [] }))
        .mockResolvedValueOnce(
          ok({ id: FACTOR, totp: { qr_code: 'qr', secret: 's' } }),
        );

      await service.startEnrollment(USER, 't');

      expect(acciones()).toEqual(['MFA_ENROLL_STARTED']);
    });

    it('un fallo al auditar el inicio del alta no impide mostrar el QR', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('db'));
      fetchMock
        .mockResolvedValueOnce(ok({ factors: [] }))
        .mockResolvedValueOnce(
          ok({ id: FACTOR, totp: { qr_code: 'qr', secret: 's' } }),
        );

      await expect(service.startEnrollment(USER, 't')).resolves.toMatchObject({
        factorId: FACTOR,
      });
    });

    it('un 200 que no es JSON da 503 y no un 500', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html>bad gateway</html>'),
      });

      await expect(service.isEnabled('t')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
