/**
 * Sala de prueba: "Probar cámara y micrófono".
 *
 * Una sala de Daily para una sola persona, que se puede abrir en cualquier
 * momento, sin turno. Sirve para lo mismo que en cualquier app de telemedicina:
 * que el paciente o el profesional confirmen antes de la consulta que el
 * navegador o el celular les dan permiso de cámara y micrófono y que se ven y se
 * escuchan bien. Así la consulta no arranca con cinco minutos de "¿me
 * escuchás?".
 *
 * No tiene nada que ver con una consulta: no se guarda en `video_sessions`, no
 * se ata a un turno y no la puede ver nadie más.
 */

/** Prefijo de las salas de prueba. Las separa de las de consulta y del spike en
 *  el namespace plano de Daily, para poder barrerlas por separado. */
export const TEST_ROOM_PREFIX = 'prueba';

/**
 * Cuánto vive la sala, en segundos. Diez minutos alcanzan de sobra para mirarse
 * en la cámara y hablar un poco; más sería pagar minutos de Daily por una sala
 * que alguien se olvidó abierta.
 */
export const TEST_ROOM_TTL_SECONDS = 10 * 60;

/**
 * Propiedades de la sala de prueba.
 *
 * - `max_participants: 1`: es para probar los propios dispositivos. Si el link
 *   se filtrara, nadie más entra, y no hay forma de usarla como una consulta
 *   fuera del sistema de turnos.
 * - `enable_prejoin_ui`: la pantalla previa de Daily es justamente la prueba:
 *   muestra la cámara, deja elegir micrófono y parlante y mide el volumen.
 * - Sin chat, sin compartir pantalla y sin grabación: no hay con quién.
 * - `eject_at_room_exp`: al vencer, Daily saca a quien siga adentro.
 */
export function testRoomProperties(expiresAtUnix: number) {
  return {
    exp: expiresAtUnix,
    eject_at_room_exp: true,
    max_participants: 1,
    enable_prejoin_ui: true,
    enable_network_ui: true,
    enable_screenshare: false,
    enable_chat: false,
    enable_recording: false,
  } as const;
}
