import 'reflect-metadata';
import { validate } from './env.validation';

const validConfig = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  SUPABASE_URL: 'https://project-ref.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
};

describe('validate (env)', () => {
  it('acepta una configuración válida y devuelve la instancia', () => {
    const result = validate({ ...validConfig });

    expect(result.DATABASE_URL).toBe(validConfig.DATABASE_URL);
    expect(result.SUPABASE_URL).toBe(validConfig.SUPABASE_URL);
    expect(result.SUPABASE_ANON_KEY).toBe(validConfig.SUPABASE_ANON_KEY);
  });

  it('acepta variables opcionales ausentes (SUPABASE_SERVICE_ROLE_KEY, NODE_ENV)', () => {
    expect(() => validate({ ...validConfig })).not.toThrow();
  });

  it('acepta un SUPABASE_URL local sin TLD (self-hosted)', () => {
    expect(() =>
      validate({ ...validConfig, SUPABASE_URL: 'http://localhost:54321' }),
    ).not.toThrow();
  });

  it('rechaza si falta DATABASE_URL', () => {
    const { DATABASE_URL, ...rest } = validConfig;
    void DATABASE_URL;
    expect(() => validate(rest)).toThrow(/Configuración de entorno inválida/);
  });

  it('rechaza un SUPABASE_URL sin protocolo', () => {
    expect(() =>
      validate({ ...validConfig, SUPABASE_URL: 'project-ref.supabase.co' }),
    ).toThrow(/Configuración de entorno inválida/);
  });

  it('rechaza un NODE_ENV con valor fuera del enum permitido', () => {
    expect(() => validate({ ...validConfig, NODE_ENV: 'staging' })).toThrow(
      /Configuración de entorno inválida/,
    );
  });

  it('acepta que falten las variables de Sentry (SDK inactivo en local y CI)', () => {
    expect(() => validate({ ...validConfig })).not.toThrow();
  });

  it('acepta un SENTRY_DSN válido', () => {
    const dsn = 'https://abc123def456@o4507.ingest.us.sentry.io/4507890';

    const result = validate({ ...validConfig, SENTRY_DSN: dsn });

    expect(result.SENTRY_DSN).toBe(dsn);
  });

  it('rechaza un SENTRY_DSN mal formado en vez de dejar de reportar en silencio', () => {
    expect(() =>
      validate({
        ...validConfig,
        SENTRY_DSN: 'o4507.ingest.us.sentry.io/4507890',
      }),
    ).toThrow(/Configuración de entorno inválida/);
  });
});
