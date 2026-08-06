import type { user_role } from '../../../generated/prisma/client';

/**
 * Datos públicos del perfil autenticado que expone `GET /me`. Contrato
 * explícito: solo campos seguros para el cliente (web/mobile hidratan la
 * sesión con esto). NO incluye el token, contraseñas ni campos internos.
 * El `role` proviene de `profiles.role` (rol de dominio), NO del JWT ni de
 * `user_metadata` — criterio de seguridad de EP-01 (escalada de privilegios).
 */
export interface MeResponseDto {
  id: string;
  email: string;
  role: user_role;
  /** Nombre/apellido viven en `patients`/`professionals`; null para perfiles
   *  sin fila asociada (ej. MODERADOR). */
  firstName: string | null;
  lastName: string | null;
}
