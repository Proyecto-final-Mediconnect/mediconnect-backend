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
