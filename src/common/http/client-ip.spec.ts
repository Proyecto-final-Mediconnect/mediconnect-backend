import { clientIp } from './client-ip';

describe('clientIp', () => {
  it('prefiere CF-Connecting-IP a req.ip (ENG-84)', () => {
    expect(
      clientIp({
        headers: { 'cf-connecting-ip': ' 203.0.113.7 ' },
        ip: '10.0.0.1',
      }),
    ).toBe('203.0.113.7');
  });

  it('cae a req.ip si el header no es una IP válida', () => {
    expect(
      clientIp({
        headers: { 'cf-connecting-ip': '1.1.1.1, 2.2.2.2' },
        ip: '::1',
      }),
    ).toBe('::1');
  });

  it('devuelve null si no hay ninguna IP válida', () => {
    expect(clientIp({ headers: {}, ip: 'basura' })).toBeNull();
    expect(clientIp({ headers: {} })).toBeNull();
  });
});
