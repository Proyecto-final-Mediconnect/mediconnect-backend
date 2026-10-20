import { plainToInstance, Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Trata el string vacío como "no definida".
 *
 * `@IsOptional()` solo saltea `null` y `undefined`. Una variable declarada y
 * vacía —que es exactamente como las deja `.env.example`— llega como `''`, no
 * la saltea, y rompe la validación y con ella el arranque. Lo encontró la
 * review de ENG-101 con `JOBS_SECRET=""`; `MERCADOPAGO_SANDBOX=""` tenía el
 * mismo problema y `.env.example` lo trae así, así que copiar el ejemplo a
 * `.env` dejaba el backend sin arrancar.
 *
 * Va antes de `@IsOptional()` en cada variable opcional cuyo valor vacío tenga
 * que significar "ausente".
 */
const EmptyAsUndefined = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  );

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

  // Secreto compartido con el workflow que dispara los jobs (`/internal/jobs/*`,
  // ENG-101). Opcional: sin él los jobs contestan 503 en vez de quedar abiertos.
  // Largo mínimo para que no se pueda adivinar. El string vacío cuenta como sin
  // definir: `@IsOptional` no lo saltea y el backend no arrancaría.
  @EmptyAsUndefined()
  @IsOptional()
  @IsString()
  @MinLength(32)
  JOBS_SECRET?: string;

  // Emails de turno con Resend (ENG-68). Opcionales: sin alguno de los dos los
  // emails quedan apagados y el resto del backend funciona igual.
  @IsOptional()
  @IsString()
  RESEND_API_KEY?: string;

  // Remitente, p. ej. `MediConnect <turnos@mediconnect.ar>`. El dominio tiene
  // que estar verificado en Resend; sin dominio propio sirve
  // `onboarding@resend.dev`, que solo entrega a la casilla dueña de la cuenta.
  @IsOptional()
  @IsString()
  EMAIL_FROM?: string;

  // Solo para apuntar a un mock de la API en pruebas manuales, igual que
  // DAILY_API_URL. Sin esto se usa https://api.resend.com.
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  RESEND_API_URL?: string;

  // Solo para apuntar a un mock de la API en pruebas manuales, igual que
  // DAILY_API_URL. Sin esto se usa el endpoint real de mercadopago.config.
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  MERCADOPAGO_API_URL?: string;

  // URL pública a la que MercadoPago manda los webhooks. Tiene que ser HTTPS y
  // alcanzable desde afuera: en local hace falta un túnel (ver el informe de
  // ENG-61). La usa ENG-63 al crear la preferencia. Se exige `https` acá porque
  // MercadoPago no notifica a `http://`: con una URL así el pago se cobra y el
  // webhook no llega nunca, sin ningún error que lo avise.
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['https'] })
  MERCADOPAGO_NOTIFICATION_URL?: string;

  // Fuerza el entorno de MercadoPago en vez de inferirlo del prefijo del token.
  // Hace falta con credenciales de un usuario de prueba, que son `APP_USR-`
  // igual que las productivas: ahí el prefijo no distingue nada. Ver
  // `MercadoPagoService.isSandbox`.
  @EmptyAsUndefined()
  @IsOptional()
  @IsIn(['true', 'false'])
  MERCADOPAGO_SANDBOX?: string;

  // Exige la aceptación de los textos legales en toda ruta autenticada y en el
  // registro (ENG-140). Opcional y apagada por default: el backend se despliega
  // antes que la web, y entre los dos deploys exigirla rompería el registro y
  // dejaría 403 a todos los usuarios existentes. Se prende cuando la web y el
  // build mobile ya están publicados — ver `docs/security/legal-enforcement.md`.
  @EmptyAsUndefined()
  @IsOptional()
  @IsIn(['true', 'false'])
  LEGAL_ENFORCEMENT?: string;
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
