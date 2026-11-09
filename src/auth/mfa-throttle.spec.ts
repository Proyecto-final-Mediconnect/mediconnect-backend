import { hashToken, mfaPendingTracker } from './mfa-throttle';

/** Tracker del rate limit del segundo paso del ingreso (ENG-88). */
describe('mfaPendingTracker', () => {
  it('con el token pendiente en la cookie (web) cuenta por token', () => {
    expect(
      mfaPendingTracker({
        cookies: { 'sb-mfa-pending': 'tok' },
        headers: { 'cf-connecting-ip': '203.0.113.7' },
        ip: '10.0.0.1',
      }),
    ).toBe(`mfa:${hashToken('tok')}`);
  });

  it('con el token pendiente en el body (app) cuenta por token', () => {
    expect(mfaPendingTracker({ body: { mfaToken: 'tok' } })).toBe(
      `mfa:${hashToken('tok')}`,
    );
  });

  it('sin token usa la IP de Cloudflare, como ClientIpThrottlerGuard', () => {
    expect(
      mfaPendingTracker({
        headers: { 'cf-connecting-ip': '203.0.113.7' },
        ip: '172.64.0.1',
      }),
    ).toBe('203.0.113.7');
  });

  it('sin token ni CF-Connecting-IP válido cae a req.ip', () => {
    expect(
      mfaPendingTracker({
        headers: { 'cf-connecting-ip': '1.1.1.1, 2.2.2.2' },
        ip: '172.64.0.1',
      }),
    ).toBe('172.64.0.1');
  });
});
