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
  // MercadoPago (ENG-61/ENG-64). El prefijo del token es lo ÚNICO que separa
  // sandbox de producción: comparten host.
  describe('MercadoPago', () => {
    it('acepta un access token de sandbox', () => {
      expect(() =>
        validate({ ...validConfig, MERCADOPAGO_ACCESS_TOKEN: 'TEST-123456' }),
      ).not.toThrow();
    });

    it('acepta un access token productivo', () => {
      expect(() =>
        validate({
          ...validConfig,
          MERCADOPAGO_ACCESS_TOKEN: 'APP_USR-123456',
        }),
      ).not.toThrow();
    });

    // El caso que justifica el @Matches: un token mal pegado tiene que romper al
    // bootear, no cuando alguien ya cobró.
    it('rechaza un access token sin prefijo de entorno', () => {
      expect(() =>
        validate({ ...validConfig, MERCADOPAGO_ACCESS_TOKEN: '123456' }),
      ).toThrow(/TEST- \(sandbox\) o APP_USR- \(producción\)/);
    });

    it('acepta que no haya credenciales de MercadoPago (CI y local)', () => {
      expect(() => validate({ ...validConfig })).not.toThrow();
    });

    it('rechaza una notification_url con http: MercadoPago solo notifica a https', () => {
      expect(() =>
        validate({
          ...validConfig,
          MERCADOPAGO_NOTIFICATION_URL: 'http://tunel.ngrok.app/webhooks',
        }),
      ).toThrow(/Configuración de entorno inválida/);
    });

    it('rechaza una notification_url sin protocolo', () => {
      expect(() =>
        validate({
          ...validConfig,
          MERCADOPAGO_NOTIFICATION_URL: 'tunel.ngrok.app/webhooks',
        }),
      ).toThrow(/Configuración de entorno inválida/);
    });
  });

  describe('JOBS_SECRET (ENG-101)', () => {
    it('vacío cuenta como sin definir: arranca y los jobs quedan apagados', () => {
      const result = validate({ ...validConfig, JOBS_SECRET: '' });

      expect(result.JOBS_SECRET).toBeUndefined();
    });

    it('rechaza un secreto de menos de 32 caracteres', () => {
      expect(() => validate({ ...validConfig, JOBS_SECRET: 'corto' })).toThrow(
        /Configuración de entorno inválida/,
      );
    });
  });

  describe('consentimiento legal (ENG-140)', () => {
    it('acepta que LEGAL_ENFORCEMENT esté ausente: la barrera queda apagada', () => {
      expect(() => validate({ ...validConfig })).not.toThrow();
      expect(validate({ ...validConfig }).LEGAL_ENFORCEMENT).toBeUndefined();
    });

    it.each(['true', 'false'])('acepta el valor %p', (value) => {
      expect(() =>
        validate({ ...validConfig, LEGAL_ENFORCEMENT: value }),
      ).not.toThrow();
    });

    it('rechaza un valor que no sea true ni false', () => {
      expect(() =>
        validate({ ...validConfig, LEGAL_ENFORCEMENT: 'si' }),
      ).toThrow(/Configuración de entorno inválida/);
    });
  });

  // `@IsOptional()` solo saltea null y undefined, así que sin el transform una
  // variable declarada y vacía rompe el arranque. Y `.env.example` las deja
  // exactamente así, con lo cual copiarlo a `.env` dejaba el backend sin
  // arrancar. Mismo problema que encontró la review de ENG-101 en JOBS_SECRET.
  describe('variables opcionales declaradas pero vacías', () => {
    it.each(['LEGAL_ENFORCEMENT', 'MERCADOPAGO_SANDBOX', 'JOBS_SECRET'])(
      '%s="" cuenta como ausente y no rompe el arranque',
      (name) => {
        expect(() => validate({ ...validConfig, [name]: '' })).not.toThrow();
        const result = validate({
          ...validConfig,
          [name]: '',
        }) as unknown as Record<string, unknown>;
        expect(result[name]).toBeUndefined();
      },
    );
  });
});
