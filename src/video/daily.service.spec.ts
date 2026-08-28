import { ConfigService } from '@nestjs/config';
import {
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DailyApiError, DailyService } from './daily.service';
import {
  MAX_PARTICIPANTS,
  ROOM_TTL_SECONDS,
  SPIKE_ROOM_PREFIX,
} from './daily.config';

/**
 * `DailyService` contra un `fetch` mockeado: se verifica el contrato que el
 * spike afirma (sala privada, tope de participantes, expiración, un token por
 * rol) sin gastar minutos de Daily ni depender de la red en CI.
 */
describe('DailyService', () => {
  const API_KEY = 'test-daily-key';
  const ROOM_NAME = `${SPIKE_ROOM_PREFIX}-a1b2c3d4`;
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

  /** Encola sala + los dos meeting tokens, en el orden en que los pide el service. */
  function stubRoomCreation(): void {
    fetchMock
      .mockResolvedValueOnce(ok({ name: ROOM_NAME, url: ROOM_URL }))
      .mockResolvedValueOnce(ok({ token: 'token-pro' }))
      .mockResolvedValueOnce(ok({ token: 'token-pac' }));
  }

  describe('isConfigured', () => {
    it('es false sin DAILY_API_KEY', () => {
      env = {};
      expect(service.isConfigured()).toBe(false);
    });

    it('es true con DAILY_API_KEY', () => {
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('createSpikeRoom', () => {
    it('sin DAILY_API_KEY da 503 y no llama a Daily', async () => {
      env = {};

      await expect(service.createSpikeRoom('Test')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('crea la sala privada, con tope de participantes y expiración', async () => {
      stubRoomCreation();
      const before = Math.floor(Date.now() / 1000);

      await service.createSpikeRoom('Test');

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
      // La sala privada es el punto del spike: con la URL sola no se entra.
      expect(body.privacy).toBe('private');
      expect(body.name).toMatch(
        new RegExp(`^${SPIKE_ROOM_PREFIX}-[0-9a-f]{8}$`),
      );
      expect(body.properties.max_participants).toBe(MAX_PARTICIPANTS);
      expect(body.properties.eject_at_room_exp).toBe(true);
      expect(body.properties.enable_recording).toBe(false);
      expect(body.properties.exp).toBeGreaterThanOrEqual(
        before + ROOM_TTL_SECONDS,
      );
    });

    it('emite un token por rol: el profesional es owner y el paciente no', async () => {
      stubRoomCreation();

      const room = await service.createSpikeRoom('Santino');

      const tokenCalls = fetchMock.mock.calls.slice(1) as [
        string,
        RequestInit,
      ][];
      expect(tokenCalls).toHaveLength(2);

      const payloads = tokenCalls.map(
        ([, init]) =>
          (
            JSON.parse(init.body as string) as {
              properties: { is_owner: boolean; room_name: string };
            }
          ).properties,
      );
      expect(payloads.map((p) => p.is_owner)).toEqual([true, false]);
      expect(payloads.every((p) => p.room_name === ROOM_NAME)).toBe(true);

      expect(room.professionalUrl).toBe(`${ROOM_URL}?t=token-pro`);
      expect(room.patientUrl).toBe(`${ROOM_URL}?t=token-pac`);
      expect(room.maxParticipants).toBe(MAX_PARTICIPANTS);
      expect(Date.parse(room.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('un fallo de Daily sale como 502, nunca con el status del proveedor', async () => {
      // Un 401 de Daily (API key vencida) propagado tal cual haría que la web
      // creyera que venció la sesión del usuario e intentara renovarla en loop.
      fetchMock.mockResolvedValueOnce(fail(401, 'invalid api key'));

      await expect(service.createSpikeRoom('Test')).rejects.toMatchObject({
        status: HttpStatus.BAD_GATEWAY,
      });
    });

    it('un error de red sale como 503 sin filtrar el detalle interno', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED 10.0.0.1:443'));

      const error: unknown = await service
        .createSpikeRoom('Test')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DailyApiError);
      const dailyError = error as DailyApiError;
      expect(dailyError.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(dailyError.message).not.toContain('ECONNREFUSED');
    });
  });

  describe('getMeetingSessions', () => {
    it('mapea la sesión y suma los minutos de participante', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({
          data: [
            {
              id: 'session-1',
              room: ROOM_NAME,
              start_time: 1_760_000_000,
              duration: 1_800,
              participants: [
                { participant_id: 'p1', duration: 1_800 },
                { participant_id: 'p2', duration: 1_740 },
              ],
            },
          ],
        }),
      );

      const [session] = await service.getMeetingSessions(ROOM_NAME);

      expect(session.durationSeconds).toBe(1_800);
      expect(session.participants).toBe(2);
      // Daily factura por minuto de participante: 30 min + 29 min = 59.
      expect(session.participantMinutes).toBe(59);
      expect(session.startTime).toBe(
        new Date(1_760_000_000 * 1000).toISOString(),
      );
    });

    it('devuelve vacío mientras la llamada sigue en curso', async () => {
      // Daily publica la sesión recién cuando termina; no es un error.
      fetchMock.mockResolvedValueOnce(ok({ data: [] }));

      await expect(service.getMeetingSessions(ROOM_NAME)).resolves.toEqual([]);
    });

    it('escapa el nombre de sala en la query', async () => {
      fetchMock.mockResolvedValueOnce(ok({ data: [] }));

      await service.getMeetingSessions('sala con espacios');

      expect(fetchMock.mock.calls[0][0]).toContain(
        `room=${encodeURIComponent('sala con espacios')}`,
      );
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
    fetchMock.mockResolvedValueOnce(ok({ data: [] }));

    await service.getMeetingSessions(ROOM_NAME);

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'http://localhost:4010/v1/meetings',
    );
  });
});
