/** ENG-85 — Tipos compartidos entre el servicio de verificación y el alertador. */
import type { ChainAnchor } from './chain-anchor';
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
  /**
   * Ancla de esta corrida (ENG-123). `null` cuando la corrida encontró
   * inconsistencias: anclar una cadena manipulada la convertiría en la nueva
   * referencia y blanquearía la manipulación, igual que pasaría al pisar el
   * snapshot.
   */
  anchor: ChainAnchor | null;
  /**
   * `true` si la raíz cambió sin que la HC haya crecido. Es la señal que
   * sobrevive aunque el atacante haya reescrito la cadena y el snapshot juntos.
   */
  anchorRegression: boolean;
}
