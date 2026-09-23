import { Reflector } from '@nestjs/core';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';

/** `getTracker` es protected: se expone solo para el test. */
class TestableGuard extends ClientIpThrottlerGuard {
  tracker(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

// El IP de salida de Cloudflare que Express ve como `req.ip` en producción.
const PROXY_IP = '172.68.10.20';

describe('ClientIpThrottlerGuard', () => {
  const guard = new TestableGuard([] as never, {} as never, new Reflector());

  it('identifica al cliente por CF-Connecting-IP y no por la IP del proxy', async () => {
    await expect(
      guard.tracker({
        ip: PROXY_IP,
        headers: { 'cf-connecting-ip': '190.12.34.56' },
      }),
    ).resolves.toBe('190.12.34.56');
  });

  it('acepta IPv6', async () => {
    await expect(
      guard.tracker({
        ip: PROXY_IP,
        headers: { 'cf-connecting-ip': '2800:810:4c3:1::1' },
      }),
    ).resolves.toBe('2800:810:4c3:1::1');
  });

  it('ignora un X-Forwarded-For armado por el cliente', async () => {
    // Si el tracker leyera la primera posición de X-Forwarded-For, cada
    // request con un valor inventado caería en un contador nuevo y el límite
    // no frenaría nunca.
    await expect(
      guard.tracker({
        ip: PROXY_IP,
        headers: { 'x-forwarded-for': '1.1.1.1' },
      }),
    ).resolves.toBe(PROXY_IP);
  });

  it('sin CF-Connecting-IP vuelve a req.ip (local, tests, o fuera de Cloudflare)', async () => {
    await expect(guard.tracker({ ip: '127.0.0.1', headers: {} })).resolves.toBe(
      '127.0.0.1',
    );
  });

  it.each([
    ['un valor que no es una IP', 'no-soy-una-ip'],
    ['dos IPs juntas (header duplicado)', '1.2.3.4, 5.6.7.8'],
    ['un string vacío', ''],
  ])('ante %s vuelve a req.ip', async (_caso, value) => {
    await expect(
      guard.tracker({ ip: PROXY_IP, headers: { 'cf-connecting-ip': value } }),
    ).resolves.toBe(PROXY_IP);
  });

  it('tolera espacios alrededor de la IP', async () => {
    await expect(
      guard.tracker({
        ip: PROXY_IP,
        headers: { 'cf-connecting-ip': ' 190.12.34.56 ' },
      }),
    ).resolves.toBe('190.12.34.56');
  });
});
