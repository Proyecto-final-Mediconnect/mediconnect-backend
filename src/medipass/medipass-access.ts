/**
 * Los accesos abiertos sobre el MediPass de un paciente (HU-35 y HU-36;
 * ENG-74, ENG-75).
 *
 * Separado del service por el mismo motivo que `vital-block.ts`: es la forma del
 * contrato con la web más la cuenta de minutos, y se puede testear sin base.
 */

/**
 * Un acceso vigente, como lo ve el paciente en su pantalla.
 *
 * Campos en español, igual que el resto del MediPass (`codigo`, `expiraEl`,
 * `vital`): el contrato lo fijó web #36 y la web lo consume tal cual.
 */
export interface MediPassAccess {
  /** Id de la sesión. Es lo que se le pasa al `DELETE` para cortarla. */
  id: string;
  /** Quién dijo ser al canjear el código. Declarado por él, no verificado. */
  consultante: string;
  /** Matrícula declarada, si la dejó. */
  matricula?: string | null;
  /** ISO-8601: cuándo abrió el acceso. */
  desde: string;
  /** ISO-8601: cuándo se cierra solo (ENG-104, 30 minutos). */
  expiraEl: string;
  /**
   * Minutos que le quedan, redondeados **hacia arriba**.
   *
   * Hacia arriba y no hacia abajo para que un acceso vivo nunca muestre
   * "0 minutos": mientras el consultante todavía puede leer la ficha, la
   * pantalla del paciente tiene que decirlo. El último minuto se muestra como 1
   * hasta que la sesión efectivamente cae.
   */
  minutosRestantes: number;
}

/**
 * Columnas de `medipass_sessions` que necesita la lista.
 *
 * `revoked_at` y `expires_at` entran aunque no se devuelvan: el filtro de
 * vigencia se evalúa en el service contra el reloj del servidor, igual que en
 * `getSessionStatus`, y no se confía en que un job haya marcado la fila.
 */
export const ACCESS_SELECT = {
  id: true,
  consultant_name: true,
  consultant_license: true,
  started_at: true,
  expires_at: true,
} as const;

/** Fila de `medipass_sessions` con lo que selecciona `ACCESS_SELECT`. */
export type AccessSource = {
  id: string;
  consultant_name: string | null;
  consultant_license: string | null;
  started_at: Date;
  expires_at: Date;
};

/**
 * Cómo se llama un consultante que abrió el acceso sin dar nombre.
 *
 * `consultant_name` es nullable en el esquema y el DTO de ENG-73 lo exige, así
 * que hoy no debería faltar nunca. Igual no se devuelve `null`: la pantalla
 * muestra esta cadena en una lista de "quién está mirando tu ficha", y un hueco
 * ahí es peor que una etiqueta honesta.
 */
export const CONSULTANTE_SIN_NOMBRE = 'Consultante sin identificar';

/** Pasa una fila de `medipass_sessions` a la forma que consume la web. */
export function toMediPassAccess(
  row: AccessSource,
  ahora: Date,
): MediPassAccess {
  const restanteMs = row.expires_at.getTime() - ahora.getTime();

  return {
    id: row.id,
    consultante: row.consultant_name ?? CONSULTANTE_SIN_NOMBRE,
    matricula: row.consultant_license,
    desde: row.started_at.toISOString(),
    expiraEl: row.expires_at.toISOString(),
    // `max(0, ...)` por si la fila se venció entre la consulta y el mapeo: un
    // número negativo en la pantalla sería un bug visible.
    minutosRestantes: Math.max(0, Math.ceil(restanteMs / 60_000)),
  };
}
