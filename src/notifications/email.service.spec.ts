import { ConfigService } from '@nestjs/config';
import { EmailDeliveryError, EmailService } from './email.service';

/** ENG-68 — envío con Resend. */

const MESSAGE = {
  to: 'paciente@test.local',
  subject: 'Asunto',
  html: '<p>Hola</p>',
  text: 'Hola',
  idempotencyKey: 'turno-1:TURNO_RESERVADO',
};

function serviceWith(env: Record<string, string | undefined>) {
  return new EmailService({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

const CONFIGURED = { RESEND_API_KEY: 're_test', EMAIL_FROM: 'MC <t@mc.test>' };

describe('EmailService', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    [{}],
    [{ RESEND_API_KEY: 're_test' }],
    [{ EMAIL_FROM: 'MC <t@mc.test>' }],
  ])('sin API key o sin remitente queda apagado (%j)', (env) => {
    expect(serviceWith(env).isConfigured()).toBe(false);
  });

  it('manda a Resend con la API key, el remitente y la clave de idempotencia', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }),
    );

    await expect(serviceWith(CONFIGURED).send(MESSAGE)).resolves.toBe(
      'email-1',
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer re_test',
      'Idempotency-Key': 'turno-1:TURNO_RESERVADO',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'MC <t@mc.test>',
      to: ['paciente@test.local'],
      subject: 'Asunto',
      html: '<p>Hola</p>',
      text: 'Hola',
    });
  });

  it.each([
    [422, true],
    [400, true],
    [401, false],
    [429, false],
    [500, false],
  ])('un %i es permanente=%s', async (status, permanent) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }));

    const error = await serviceWith(CONFIGURED)
      .send(MESSAGE)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as EmailDeliveryError).permanent).toBe(permanent);
  });

  it('una falla de red se reintenta', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const error = await serviceWith(CONFIGURED)
      .send(MESSAGE)
      .catch((err: unknown) => err);

    expect((error as EmailDeliveryError).permanent).toBe(false);
  });
});
