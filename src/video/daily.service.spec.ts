import { ConfigService } from '@nestjs/config';
import {
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DailyApiError, DailyService } from './daily.service';
import { CONSULTATION_ROOM_PREFIX } from './consultation.config';
import { TEST_ROOM_PREFIX, TEST_ROOM_TTL_SECONDS } from './test-room.config';

/**
 * `DailyService` contra un `fetch` mockeado: se verifica el contrato con Daily
 * (sala privada, tope de participantes, expiración, errores traducidos) sin
 * gastar minutos de Daily ni depender de la red en CI.
 */
describe('DailyService', () => {
  const API_KEY = 'test-daily-key';
  const ROOM_NAME = `${CONSULTATION_ROOM_PREFIX}-a1b2c3d4e5f6`;
  const ROOM_URL = `https://mediconnect.daily.co/${ROOM_NAME}`;

  let service: DailyService;
  let fetchMock: jest.Mock;
  /** Env que ve el ConfigService mockeado; cada test la puede ajustar. */
  let env: Record<string, string | undefined>;

  /** Respuesta JSON exitosa, con la forma que devuelve `fetch`. */
  function ok(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }

  function fail(status: number, detail = ''): Response {
    return {
      ok: false,
      status,
      text: () => Promise.resolve(detail),
    } as unknown as Response;
  }

  beforeEach(() => {
    env = { DAILY_API_KEY: API_KEY };
    fetchMock = jest.fn();
    global.fetch = fetchMock;

    const config = {
      get: (key: string) => env[key],
      getOrThrow: (key: string) => {
        const value = env[key];
        if (value === undefined) throw new Error(`falta ${key}`);
        return value;
      },
    } as unknown as ConfigService;

    service = new DailyService(config);
    // Los tests que ejercitan fallos loguean a nivel error; silenciarlo deja la
    // salida de la suite legible.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isConfigured', () => {
    it('es false sin DAILY_API_KEY', () => {
      env = {};
      expect(service.isConfigured()).toBe(false);
    });

    it('es true con DAILY_API_KEY', () => {
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('createConsultationRoom', () => {
    it('sin DAILY_API_KEY da 503 y no llama a Daily', async () => {
      env = {};

      await expect(
        service.createConsultationRoom(1_800_000_000, 'off'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('crea la sala privada, con tope de participantes y la expiración del turno', async () => {
      fetchMock.mockResolvedValueOnce(ok({ name: ROOM_NAME, url: ROOM_URL }));

      const room = await service.createConsultationRoom(1_800_000_000, 'off');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.daily.co/v1/rooms');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${API_KEY}`,
      );
      const body = JSON.parse(init.body as string) as {
        name: string;
        privacy: string;
        properties: Record<string, unknown>;
      };
      // Privada: con la URL sola no se entra, hace falta el meeting token.
      expect(body.privacy).toBe('private');
      expect(body.name).toMatch(
        new RegExp(`^${CONSULTATION_ROOM_PREFIX}-[0-9a-f-]{12}$`),
      );
      expect(body.properties.max_participants).toBe(2);
      expect(body.properties.eject_at_room_exp).toBe(true);
      expect(body.properties.exp).toBe(1_800_000_000);
      // Sin tokens: se emiten por ingreso.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(room).toEqual({ name: ROOM_NAME, url: ROOM_URL });
    });
  });

  describe('errores de Daily', () => {
    it('un fallo de Daily sale como 502, nunca con el status del proveedor', async () => {
      // Un 401 de Daily (API key vencida) propagado tal cual haría que la web
      // creyera que venció la sesión del usuario e intentara renovarla en loop.
      fetchMock.mockResolvedValueOnce(fail(401, 'invalid api key'));

      await expect(
        service.createConsultationRoom(1_800_000_000, 'off'),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });
    });

    it('un error de red sale como 503 sin filtrar el detalle interno', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED 10.0.0.1:443'));

      const error: unknown = await service
        .createConsultationRoom(1_800_000_000, 'off')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DailyApiError);
      const dailyError = error as DailyApiError;
      expect(dailyError.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(dailyError.message).not.toContain('ECONNREFUSED');
    });
  });

  describe('createTestRoom', () => {
    const TEST_NAME = `${TEST_ROOM_PREFIX}-0123456789ab`;
    const TEST_URL = `https://mediconnect.daily.co/${TEST_NAME}`;

    it('sin DAILY_API_KEY da 503 y no llama a Daily', async () => {
      env = {};

      await expect(service.createTestRoom('Vos')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('crea una sala privada para una sola persona, que vence en diez minutos', async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ name: TEST_NAME, url: TEST_URL }))
        .mockResolvedValueOnce(ok({ token: 'token-prueba' }));
      const before = Math.floor(Date.now() / 1000);

      const sala = await service.createTestRoom('Vos');

      const body = JSON.parse(
        (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
      ) as {
        name: string;
        privacy: string;
        properties: Record<string, unknown>;
      };
      expect(body.privacy).toBe('private');
      expect(body.name).toMatch(
        new RegExp(`^${TEST_ROOM_PREFIX}-[0-9a-f]{16}$`),
      );
      expect(body.properties).toMatchObject({
        max_participants: 1,
        enable_prejoin_ui: true,
        enable_chat: false,
        enable_screenshare: false,
        enable_recording: false,
        eject_at_room_exp: true,
      });
      const exp = body.properties.exp as number;
      expect(exp).toBeGreaterThanOrEqual(before + TEST_ROOM_TTL_SECONDS);
      expect(exp).toBeLessThanOrEqual(before + TEST_ROOM_TTL_SECONDS + 5);

      expect(sala).toEqual({
        url: `${TEST_URL}?t=token-prueba`,
        expiraEl: new Date(exp * 1000).toISOString(),
      });
    });

    it('el token es de esa sala, vence con ella y no es owner', async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ name: TEST_NAME, url: TEST_URL }))
        .mockResolvedValueOnce(ok({ token: 'token-prueba' }));

      await service.createTestRoom('Vos');

      const sala = JSON.parse(
        (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
      ) as { properties: { exp: number } };
      const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(url).toBe('https://api.daily.co/v1/meeting-tokens');
      expect(JSON.parse(init.body as string)).toEqual({
        properties: {
          room_name: TEST_NAME,
          user_name: 'Vos',
          is_owner: false,
          exp: sala.properties.exp,
        },
      });
    });
  });

  describe('deleteRoom', () => {
    it('trata el 404 como éxito: la sala ya no está, que era el objetivo', async () => {
      fetchMock.mockResolvedValueOnce(fail(404));

      await expect(service.deleteRoom(ROOM_NAME)).resolves.toBeUndefined();
    });

    it('propaga cualquier otro error', async () => {
      fetchMock.mockResolvedValueOnce(fail(500));

      await expect(service.deleteRoom(ROOM_NAME)).rejects.toBeInstanceOf(
        DailyApiError,
      );
    });

    it('no rompe cuando Daily contesta con cuerpo vacío', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: () => Promise.resolve(''),
      });

      await expect(service.deleteRoom(ROOM_NAME)).resolves.toBeUndefined();
    });
  });

  it('respeta DAILY_API_URL cuando se apunta a un mock', async () => {
    env.DAILY_API_URL = 'http://localhost:4010/v1';
    fetchMock.mockResolvedValueOnce(ok({}));

    await service.deleteRoom(ROOM_NAME);

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `http://localhost:4010/v1/rooms/${ROOM_NAME}`,
    );
  });
});
