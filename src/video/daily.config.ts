/**
 * Configuración del cliente de Daily.co.
 *
 * Las propiedades de cada tipo de sala viven con su caso de uso:
 * `consultation.config.ts` (videoconsulta, ENG-56) y `test-room.config.ts`
 * (prueba de cámara y micrófono). Las del spike de ENG-51 se borraron con su
 * banco de pruebas (ENG-151); el informe del spike queda en mediconnect-docs.
 */

/** Base de la API REST de Daily. Se deja configurable por si alguna vez hay que
 *  apuntar a un mock; el default es el endpoint real. */
export const DAILY_API_URL = 'https://api.daily.co/v1';
