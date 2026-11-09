import { Reflector } from '@nestjs/core';
import { UserThrottlerGuard } from './user-throttler.guard';

/** `getTracker` es protected: se expone solo para el test. */
class TestableGuard extends UserThrottlerGuard {
  tracker(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

describe('UserThrottlerGuard', () => {
  const guard = new TestableGuard([] as never, {} as never, new Reflector());
  const SUB = '11111111-1111-4111-8111-111111111111';

  it('cuenta por usuario autenticado', async () => {
    await expect(
      guard.tracker({ user: { id: SUB }, ip: '10.0.0.1', headers: {} }),
    ).resolves.toBe(`user:${SUB}`);
  });

  it('dos usuarios en la misma IP tienen contadores distintos', async () => {
    const ip = '190.12.34.56';
    const a = await guard.tracker({
      user: { id: SUB },
      headers: { 'cf-connecting-ip': ip },
    });
    const b = await guard.tracker({
      user: { id: '22222222-2222-4222-8222-222222222222' },
      headers: { 'cf-connecting-ip': ip },
    });
    expect(a).not.toBe(b);
  });

  it('sin usuario cae a la IP real del cliente', async () => {
    await expect(
      guard.tracker({ headers: { 'cf-connecting-ip': '190.12.34.56' } }),
    ).resolves.toBe('ip:190.12.34.56');
  });

  it('sin usuario ni IP válida no revienta', async () => {
    await expect(guard.tracker({ headers: {} })).resolves.toBe(
      'ip:desconocida',
    );
  });
});
