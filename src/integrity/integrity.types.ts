/** ENG-85 — Tipos compartidos entre el servicio de verificación y el alertador. */
import type { ChainAnchor } from './chain-anchor';
import type { IntegrityFailure } from './chain-audit';

/**
 * `OK` / `INCONSISTENT` son los de esquema.md. Los otros dos los suman los
 * tickets, y en los dos casos por la misma razón: un estado que se colapsa
 * dentro de otro deja una racha de `OK` que nadie mira.
 *
 * - `ERROR` (ENG-85): la corrida no pudo terminar (base caída, credencial
 *   vencida). No es lo mismo que una corrida que verificó y no encontró nada.
 * - `ANCHOR_REGRESSION` (ENG-123): todas las cadenas verificaron, pero la raíz
 *   del ancla cambió sin que la HC creciera. No es `INCONSISTENT` —no hay
 *   ninguna inconsistencia por paciente que listar— y sobre todo NO es `OK`: la
 *   búsqueda de la línea de base filtra por `OK`, así que registrarla como sana
 *   haría que la corrida siguiente adoptara la raíz manipulada como referencia y
 *   el job volviera a dar verde para siempre.
 */
export type IntegrityStatus =
  | 'OK'
  | 'INCONSISTENT'
  | 'ANCHOR_REGRESSION'
  | 'ERROR';

export interface IntegrityRunResult {
  /** `id` de la fila escrita en `integrity_checks`. */
  checkId: string;
  status: Exclude<IntegrityStatus, 'ERROR'>;
  patientsChecked: number;
  entriesChecked: number;
  durationMs: number;
  /** Solo tiene contenido cuando `status === 'INCONSISTENT'`. */
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
   * Cuando es `true`, `status` es `ANCHOR_REGRESSION`.
   */
  anchorRegression: boolean;
}
