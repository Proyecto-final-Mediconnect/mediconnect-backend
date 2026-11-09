import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import { EXPO_PUSH_TOKEN_PATTERN, PushService } from './push.service';

const USER = 'user-1';
const A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const MESSAGE = {
  title: 'Nuevo mensaje',
  body: 'Ana García te escribió.',
  data: { tipo: 'NUEVO_MENSAJE', conversationId: 'c-1' },
};

describe('PushService', () => {
  let prisma: {
    pushToken: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let env: Record<string, string | undefined>;
  let fetchMock: jest.SpyInstance;
  let service: PushService;

  function expoAnswers(body: unknown, status = 200) {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  beforeEach(() => {
    prisma = {
      pushToken: {
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([{ token: A }, { token: B }]),
      },
    };
    env = {};
    fetchMock = jest.spyOn(globalThis, 'fetch');
    service = new PushService(
      prisma as unknown as PrismaService,
      { get: (key: string) => env[key] } as unknown as ConfigService,
    );
  });

  afterEach(() => fetchMock.mockRestore());

  it('acepta solo tokens de Expo', () => {
    expect(EXPO_PUSH_TOKEN_PATTERN.test(A)).toBe(true);
    expect(EXPO_PUSH_TOKEN_PATTERN.test('ExpoPushToken[x_y-z]')).toBe(true);
    expect(EXPO_PUSH_TOKEN_PATTERN.test('fcm:abc')).toBe(false);
    expect(EXPO_PUSH_TOKEN_PATTERN.test('ExponentPushToken[a]; drop')).toBe(
      false,
    );
  });

  it('registrar un token que era de otro usuario lo pasa al nuevo', async () => {
    await service.register(USER, A, 'android');

    expect(prisma.pushToken.upsert).toHaveBeenCalledWith({
      where: { token: A },
      create: { user_id: USER, token: A, platform: 'android' },
      update: { user_id: USER, platform: 'android' },
    });
  });

  it('borrar solo toca el token del propio usuario', async () => {
    await service.unregister(USER, A);

    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { token: A, user_id: USER },
    });
  });

  it('manda un push por dispositivo al canal de mensajes', async () => {
    expoAnswers({ data: [{ status: 'ok' }, { status: 'ok' }] });

    await service.sendToUser(USER, MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(JSON.parse(init.body as string)).toEqual([
      expect.objectContaining({ to: A, channelId: 'mensajes', ...MESSAGE }),
      expect.objectContaining({ to: B, channelId: 'mensajes', ...MESSAGE }),
    ]);
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(prisma.pushToken.deleteMany).not.toHaveBeenCalled();
  });

  it('con EXPO_ACCESS_TOKEN lo manda como Bearer', async () => {
    env.EXPO_ACCESS_TOKEN = 'secreto';
    expoAnswers({ data: [{ status: 'ok' }, { status: 'ok' }] });

    await service.sendToUser(USER, MESSAGE);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toHaveProperty('Authorization', 'Bearer secreto');
  });

  it('sin dispositivos no llama a Expo', async () => {
    prisma.pushToken.findMany.mockResolvedValue([]);

    await service.sendToUser(USER, MESSAGE);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un dispositivo que ya no existe se borra; otro error no', async () => {
    expoAnswers({
      data: [
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', details: { error: 'MessageRateExceeded' } },
      ],
    });

    await service.sendToUser(USER, MESSAGE);

    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: [A] } },
    });
  });

  it.each([
    ['Expo caído', () => fetchMock.mockRejectedValue(new Error('ECONNRESET'))],
    ['un 500', () => expoAnswers({ errors: [] }, 500)],
    [
      'la base falla',
      () => prisma.pushToken.findMany.mockRejectedValue(new Error('db')),
    ],
  ])('nunca tira: %s', async (_, arrange) => {
    arrange();

    await expect(service.sendToUser(USER, MESSAGE)).resolves.toBeUndefined();
    expect(prisma.pushToken.deleteMany).not.toHaveBeenCalled();
  });
});
