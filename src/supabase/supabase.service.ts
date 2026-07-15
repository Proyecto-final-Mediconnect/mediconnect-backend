import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';

// Tipo del cliente tal como lo infiere `createClient`. Declarar el campo con
// este tipo (en vez de `SupabaseClient` con genéricos por defecto) evita el
// `no-unsafe-assignment` por desajuste de parámetros genéricos de la librería.
type SupabaseAnonClient = ReturnType<typeof createClient>;

/**
 * Provee un cliente de Supabase configurado con la anon key.
 * Se usa para operaciones de Supabase Auth (signUp, signIn, etc.).
 * El registro/verificación de email pasa por acá; el perfil en la tabla
 * `profiles` lo crea un trigger de Postgres al insertarse el usuario.
 */
@Injectable()
export class SupabaseService implements OnModuleInit {
  private client!: SupabaseAnonClient;

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
  }

  getClient(): SupabaseAnonClient {
    return this.client;
  }
}
