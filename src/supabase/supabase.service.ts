import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

// Tipo del cliente tal como lo infiere `createClient`. Declarar el campo con
// este tipo (en vez de `SupabaseClient` con genéricos por defecto) evita el
// `no-unsafe-assignment` por desajuste de parámetros genéricos de la librería.
type SupabaseAnonClient = ReturnType<typeof createClient>;

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

    this.client = createClient(url, anonKey, {
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

  getJWKS(): JWTVerifyGetKey {
    return this.jwks;
  }

  getIssuer(): string {
    return this.issuer;
  }
}
