import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

// supabase-js infiere Insert/Update como `never` cuando no se le pasa un tipo de
// Database (empuja a generar tipos con `supabase gen types typescript`). Hasta
// que exista ese archivo generado, usamos un esquema laxo que permite escribir;
// la forma real de cada fila la tipan las interfaces *Row en cada service.
// TODO(ENG-48): reemplazar por los tipos generados de Supabase.
type LooseTable = {
  Row: Record<string, unknown>;
  Insert: Record<string, unknown>;
  Update: Record<string, unknown>;
  Relationships: [];
};
interface LooseDatabase {
  public: {
    Tables: Record<string, LooseTable>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

// Tipo del cliente ya parametrizado con el esquema laxo. Declarar el campo con
// este tipo evita el `no-unsafe-assignment` por desajuste de genéricos.
type SupabaseAnonClient = ReturnType<typeof createClient<LooseDatabase>>;

/**
 * Provee un cliente de Supabase configurado con la anon key, y el JWKS del
 * proyecto para verificar JWTs localmente (ver ENG-40/ENG-92: los tokens se
 * firman con ES256, no hay JWT_SECRET). El JWKS se construye una única vez
 * (singleton, cacheado por `createRemoteJWKSet`) y no por request.
 * El registro/verificación de email pasa por acá; el perfil en la tabla
 * `profiles` lo crea un trigger de Postgres al insertarse el usuario.
 */
@Injectable()
export class SupabaseService implements OnModuleInit {
  private client!: SupabaseAnonClient;
  private jwks!: JWTVerifyGetKey;
  private issuer!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    const anonKey = this.config.getOrThrow<string>('SUPABASE_ANON_KEY');

    this.client = createClient<LooseDatabase>(url, anonKey, {
      auth: {
        // El backend no persiste sesión: cada request es stateless.
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // Sin slash final: un SUPABASE_URL con `/` al final generaría `//auth/v1`
    // y el `issuer` no matchearía el `iss` del token → todo 401 (JwtAuthGuard).
    this.issuer = `${url.replace(/\/+$/, '')}/auth/v1`;
    this.jwks = createRemoteJWKSet(
      new URL(`${this.issuer}/.well-known/jwks.json`),
    );
  }

  getClient(): SupabaseAnonClient {
    return this.client;
  }

  /**
   * Cliente de Supabase que actúa EN NOMBRE del usuario: adjunta su access
   * token en el header Authorization, de modo que las políticas RLS evalúen
   * `auth.uid()` como el `profiles.id` del usuario (ver ENG-37). Se usa para
   * lecturas/escrituras de datos propios (ej. el profesional editando su
   * perfil) sin necesidad de la service_role key.
   */
  getClientForToken(accessToken: string): SupabaseAnonClient {
    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    const anonKey = this.config.getOrThrow<string>('SUPABASE_ANON_KEY');

    return createClient<LooseDatabase>(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  getJWKS(): JWTVerifyGetKey {
    return this.jwks;
  }

  getIssuer(): string {
    return this.issuer;
  }
}
