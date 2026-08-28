/** ENG-85 — Tipos compartidos entre el servicio de verificación y el alertador. */
import type { IntegrityFailure } from './chain-audit';

/**
 * `OK` / `INCONSISTENT` son los de esquema.md. `ERROR` lo suma ENG-85: una
 * corrida que no pudo terminar no es lo mismo que una que verificó y no encontró
 * nada, y si se registran igual, un job que falla en silencio deja una racha de
 * "OK" que nadie mira.
 */
export type IntegrityStatus = 'OK' | 'INCONSISTENT' | 'ERROR';

export interface IntegrityRunResult {
  /** `id` de la fila escrita en `integrity_checks`. */
  checkId: string;
  status: Exclude<IntegrityStatus, 'ERROR'>;
  patientsChecked: number;
  entriesChecked: number;
  durationMs: number;
  /** Vacío cuando `status === 'OK'`. */
  failures: IntegrityFailure[];
}
