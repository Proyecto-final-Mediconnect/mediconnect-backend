/**
 * Cómo se le cuenta al paciente qué miró un consultante (ENG-76).
 *
 * `medipass_access_logs.resource_accessed` es texto libre. Hoy lo escriben dos
 * lados: `MediPassService.openSession` (`medipass.vital`, al abrir el acceso) y
 * el seed de demo, con los bloques que va a tener el alcance de ENG-149
 * (`alergias`, `medicacion_activa`, `diagnosticos`). Cuando se agreguen bloques
 * nuevos, se suman acá con el mismo nombre que use quien escribe la bitácora.
 */
const RESOURCE_LABELS: Record<string, string> = {
  'medipass.vital':
    'Información vital: alergias, medicación, condiciones y contacto de emergencia',
  alergias: 'Alergias',
  medicacion_activa: 'Medicación activa',
  diagnosticos: 'Diagnósticos',
  condiciones: 'Condiciones',
  contacto_emergencia: 'Contacto de emergencia',
};

/** Etiqueta legible de un recurso. Uno desconocido no se esconde: se nombra igual. */
export function resourceLabel(resource: string | null): string {
  if (!resource) return 'Información del MediPass';
  return RESOURCE_LABELS[resource] ?? 'Otra información del MediPass';
}

export type AccessStatus = 'ACTIVO' | 'VENCIDO' | 'REVOCADO';

/**
 * Estado de una sesión vista desde hoy. Revocada gana sobre vencida: si el
 * paciente la cortó, eso es lo que importa contar, aunque ya hubiera vencido
 * igual a esta altura.
 */
export function accessStatus(
  session: { expires_at: Date; revoked_at: Date | null },
  now: Date,
): AccessStatus {
  if (session.revoked_at) return 'REVOCADO';
  return session.expires_at > now ? 'ACTIVO' : 'VENCIDO';
}
