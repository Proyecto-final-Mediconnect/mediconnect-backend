/** Datos del usuario autenticado, derivados del payload del JWT de Supabase. */
export interface AuthenticatedUser {
  /** `payload.sub` — coincide con `profiles.id` y con `auth.uid()` de RLS. */
  id: string;
  email?: string;
  role?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmentación estándar de Express vía declaration merging
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
