import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Provee un cliente de Supabase configurado con la anon key.
 * Se usa para operaciones de Supabase Auth (signUp, signIn, etc.).
 * El registro/verificación de email pasa por acá; el perfil en la tabla
 * `profiles` lo crea un trigger de Postgres al insertarse el usuario.
 */
@Injectable()
export class SupabaseService implements OnModuleInit {
  private client!: SupabaseClient;

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

  getClient(): SupabaseClient {
    return this.client;
  }
}
