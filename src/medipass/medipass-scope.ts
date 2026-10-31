import type { VitalBlock } from './vital-block';

/**
 * Qué bloques del MediPass ve un consultante externo (ENG-149).
 *
 * El nombre y la edad no son configurables: sin ellos el médico no sabe de
 * quién es la ficha que está leyendo. Lo demás, el paciente lo puede apagar.
 */
export interface MediPassScope {
  grupoSanguineo: boolean;
  alergias: boolean;
  medicacion: boolean;
  condiciones: boolean;
  contacto: boolean;
}

export const SCOPE_BLOCKS = [
  'grupoSanguineo',
  'alergias',
  'medicacion',
  'condiciones',
  'contacto',
] as const satisfies readonly (keyof MediPassScope & keyof VitalBlock)[];

/**
 * Sin configurar, **todo visible**: en una emergencia lo que salva una vida es
 * la información, y que el paciente tenga que acordarse de prender cada bloque
 * dejaría la ficha vacía justo cuando hace falta.
 */
export const DEFAULT_SCOPE: MediPassScope = {
  grupoSanguineo: true,
  alergias: true,
  medicacion: true,
  condiciones: true,
  contacto: true,
};

/**
 * La columna `jsonb` a un scope completo. Lo que no es un booleano (o falta)
 * vale el default: una fila escrita a mano o un bloque nuevo agregado después
 * no pueden esconder información por accidente.
 */
export function resolveScope(raw: unknown): MediPassScope {
  const guardado =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    SCOPE_BLOCKS.map((b) => [
      b,
      typeof guardado[b] === 'boolean' ? guardado[b] : DEFAULT_SCOPE[b],
    ]),
  ) as unknown as MediPassScope;
}

/**
 * La ficha recortada por el scope. Un bloque apagado **no aparece**: ni vacío
 * ni en `null`, para que el consultante no pueda distinguir "lo ocultó" de "no
 * lo cargó".
 */
export function applyScope(
  vital: VitalBlock,
  scope: MediPassScope,
): VitalBlock {
  const recortada: VitalBlock = { ...vital };
  for (const bloque of SCOPE_BLOCKS) {
    if (!scope[bloque]) delete recortada[bloque];
  }
  return recortada;
}
