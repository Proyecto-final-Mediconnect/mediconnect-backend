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

      const alta = await service.startEnrollment('t');

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

      await expect(service.startEnrollment('t')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
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

    it('sin la verificación activa no hay nada que desactivar', async () => {
      fetchMock.mockResolvedValueOnce(ok({ factors: [] }));

      await expect(service.disable(USER, 't', '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
