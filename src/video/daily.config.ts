/**
 * Configuración del cliente de Daily.co (ENG-51).
 *
 * Vive aparte del service para que las constantes que el spike quiere discutir
 * (cuánto vive una sala, cuántos participantes entran, qué features del Prebuilt
 * se prenden) se lean de un vistazo y no haya que bucear en la lógica HTTP.
 */

/** Base de la API REST de Daily. Se deja configurable por si alguna vez hay que
 *  apuntar a un mock; el default es el endpoint real. */
export const DAILY_API_URL = 'https://api.daily.co/v1';

/**
 * Prefijo de las salas que crea este spike. Las salas de Daily viven en un
 * namespace plano por dominio, así que sin prefijo una sala de prueba y una de
 * producción serían indistinguibles a la hora de limpiar.
 */
export const SPIKE_ROOM_PREFIX = 'spike-eng51';

/**
 * Vida de la sala de prueba, en segundos.
 *
 * 40 minutos y no 30: la medición del criterio de aceptación es una llamada de
 * 30 minutos, y si la sala expirara justo al cumplirse, la prueba se cortaría
 * sola antes de poder cerrar la toma de métricas. El margen es deliberado.
 *
 * Que la sala expire sí o sí es importante: el plan Free de Daily cobra por
 * minutos de participante, y una sala olvidada abierta es una factura abierta.
 */
export const ROOM_TTL_SECONDS = 40 * 60;

/**
 * Vida del meeting token, en segundos. Más corto que la sala: el token es la
 * credencial de entrada y no tiene por qué sobrevivir a la sesión.
 */
export const TOKEN_TTL_SECONDS = 45 * 60;

/**
 * Tope de participantes de una videoconsulta: paciente + profesional.
 *
 * Se fija en el spike porque es una propiedad de la sala (no del cliente): si el
 * link se filtra, un tercero no puede entrar aunque tenga la URL, porque la sala
 * ya está llena. Es la primera línea de defensa antes del meeting token.
 */
export const MAX_PARTICIPANTS = 2;

/**
 * Propiedades del Prebuilt que el spike valida. Lo que se prende y lo que no
 * responde al caso de uso "consulta médica", no a "reunión genérica":
 *
 * - `enable_prejoin_ui`: pantalla previa para elegir cámara/micrófono. En una
 *   consulta médica entrar con la cámara prendida sin querer es un problema de
 *   privacidad, no una molestia.
 * - `enable_network_ui`: indicador de calidad de conexión. Es además de dónde
 *   sale, en vivo, parte de la medición del criterio 3.
 * - `enable_screenshare`: el profesional comparte un estudio o una imagen.
 * - `enable_chat`: chat dentro de la sala. El chat persistente del producto es
 *   otro módulo (EP-08); este es efímero y muere con la sala.
 * - `enable_recording: false`: grabar una consulta médica tiene implicancias
 *   legales (Ley 25.326) que no se resuelven en un spike. La grabación de audio
 *   para el pipeline de IA (EP-07) se define en su propio ticket.
 * - `eject_at_room_exp`: al expirar la sala, Daily saca a todos. Sin esto la
 *   expiración solo impide entrar, pero los que ya están siguen consumiendo
 *   minutos.
 */
export const ROOM_PROPERTIES = {
  enable_prejoin_ui: true,
  enable_network_ui: true,
  enable_screenshare: true,
  enable_chat: true,
  enable_recording: false,
  eject_at_room_exp: true,
  max_participants: MAX_PARTICIPANTS,
} as const;
