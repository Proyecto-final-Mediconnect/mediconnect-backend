import express from 'express';
import request from 'supertest';
import { securityHeaders } from './security-headers';

/** ENG-166: lo que el Sprint 0 promete que trae cada respuesta de la API. */
describe('securityHeaders', () => {
  const app = express();
  app.use(securityHeaders());
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  it('trae CSP cerrada, X-Frame-Options, HSTS y nosniff', async () => {
    const res = await request(app).get('/health').expect(200);

    expect(res.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(res.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['strict-transport-security']).toContain(
      'max-age=31536000',
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('deja que la web, en otro dominio, lea las respuestas', async () => {
    const res = await request(app).get('/health').expect(200);

    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('no anuncia el framework', async () => {
    const res = await request(app).get('/health').expect(200);

    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
