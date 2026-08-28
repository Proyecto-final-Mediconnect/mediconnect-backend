import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
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
