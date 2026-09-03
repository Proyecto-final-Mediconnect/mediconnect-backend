import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  @IsString()
  DATABASE_URL!: string;

  // Origen del JWKS usado para verificar JWTs de Supabase (ver ENG-40/ENG-92).
  // `require_tld: false` porque en desarrollo local puede apuntar a una
  // instancia self-hosted (ej. http://localhost:54321).
  @IsUrl({ require_tld: false, require_protocol: true })
  SUPABASE_URL!: string;

  @IsString()
  SUPABASE_ANON_KEY!: string;

  // No usada hoy por el código; se documenta en .env.example para operaciones
  // futuras con privilegios de service_role. Opcional para no romper CI/local.
  @IsOptional()
  @IsString()
  SUPABASE_SERVICE_ROLE_KEY?: string;

  @IsOptional()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV?: string;

  // Monitoreo de errores (ENG-83). Opcional a propósito: sin DSN el SDK queda
  // inactivo, y así local y CI corren sin configuración extra ni eventos de
  // desarrollo ensuciando el dashboard. Se valida como URL para que un DSN mal
  // pegado falle al bootear en vez de dejar de reportar en silencio.
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  SENTRY_DSN?: string;

  // Separa producción de staging en el dashboard. Si falta, `instrument.ts` cae
  // a NODE_ENV.
  @IsOptional()
  @IsString()
  SENTRY_ENVIRONMENT?: string;

  // Versión desplegada (ej. el SHA del commit), para distinguir errores nuevos
  // de los que ya venían.
  @IsOptional()
  @IsString()
  SENTRY_RELEASE?: string;

  // Daily.co (ENG-51). Opcional por el mismo motivo que SENTRY_DSN: sin ella el
  // backend tiene que bootear igual en CI y en local, donde no hay credenciales
  // de terceros. Los endpoints de video contestan 503 explicando que falta, en
  // vez de tumbar toda la app por una feature que la mayoría de los tickets no
  // toca.
  @IsOptional()
  @IsString()
  DAILY_API_KEY?: string;

  // Solo para apuntar a un mock de la API de Daily en pruebas manuales. Si no se
  // declara, `DailyService` usa el endpoint real (`DAILY_API_URL` de daily.config).
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  DAILY_API_URL?: string;

  // Grabación de audio de la videoconsulta (ENG-56). `cloud-audio-only` la
  // prende; cualquier otra cosa —incluida la ausencia— la deja apagada. El
  // default apagado no es cautela genérica: grabar una consulta necesita
  // consentimiento y base legal (Ley 25.326) y un plan pago de Daily. Ver
  // consultation.config.ts.
  @IsOptional()
  @IsIn(['off', 'cloud-audio-only'])
  VIDEO_RECORDING_MODE?: string;

  // MercadoPago (ENG-61/ENG-64, ADR-013). Opcional por el mismo motivo que
  // DAILY_API_KEY: CI y local tienen que bootear sin credenciales de terceros, y
  // los endpoints de pago contestan 503 explicando que falta.
  //
  // El prefijo separa los dos entornos y es lo ÚNICO que los separa: sandbox y
  // producción comparten el host `api.mercadopago.com`. `TEST-` cobra de
  // mentira, `APP_USR-` cobra de verdad. Se valida el formato acá para que un
  // token productivo pegado por error en un `.env` de desarrollo se note al
  // bootear y no cuando alguien ya cobró.
  @IsOptional()
  @Matches(/^(TEST|APP_USR)-/, {
    message:
      'MERCADOPAGO_ACCESS_TOKEN debe empezar con TEST- (sandbox) o APP_USR- (producción).',
  })
  MERCADOPAGO_ACCESS_TOKEN?: string;

  // Clave secreta del webhook, del panel de MercadoPago. Es lo que firma el
  // manifest de las notificaciones: sin ella el endpoint público de ENG-64 no
  // puede distinguir a MercadoPago de cualquiera, y por eso rechaza todo cuando
  // falta en vez de procesar sin verificar.
  @IsOptional()
  @IsString()
  MERCADOPAGO_WEBHOOK_SECRET?: string;

  // Solo para apuntar a un mock de la API en pruebas manuales, igual que
  // DAILY_API_URL. Sin esto se usa el endpoint real de mercadopago.config.
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  MERCADOPAGO_API_URL?: string;

  // URL pública a la que MercadoPago manda los webhooks. Tiene que ser HTTPS y
  // alcanzable desde afuera: en local hace falta un túnel (ver el informe de
  // ENG-61). El spike la usa al crear la preferencia.
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  MERCADOPAGO_NOTIFICATION_URL?: string;
}

/** Falla rápido al bootear si falta o está mal formada una env var requerida,
 *  en vez de dejar que cada servicio la descubra por su cuenta en runtime. */
export function validate(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Configuración de entorno inválida: ${details}`);
  }

  return validated;
}
