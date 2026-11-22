/** Cuánto después del final del turno el profesional todavía puede cerrarlo a
 *  mano (ENG-189) o informar una falla técnica (ENG-237). Pasado eso, el turno
 *  lo cerró el job o queda como está.
 *
 *  Vive en un archivo propio, sin dependencias, porque lo leen el cierre, la
 *  vista de los turnos y `GET /config` (ENG-229). */
export const MANUAL_CLOSE_HOURS_AFTER = 24;
