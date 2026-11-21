/**
 * Configuración de la sala de una videoconsulta real (ENG-56).
 *
 * Una sala atada a un turno, que nace y muere con él. La de la prueba de cámara
 * y micrófono tiene su propia configuración (`test-room.config.ts`).
 */

/** Prefijo de las salas de consulta. Las de la prueba de cámara usan `prueba-`,
 *  así que las dos poblaciones quedan separadas en el namespace plano de Daily y
 *  se pueden barrer por separado. */
export const CONSULTATION_ROOM_PREFIX = 'consulta';

/**
 * Cuántos minutos ANTES del horario se puede entrar.
 *
 * Es el criterio de aceptación de ENG-56 ("el botón aparece 10 minutos antes").
 * Está acá y no en el componente de la web porque la web solo decide si dibuja
 * el botón: quien autoriza es el backend. Si solo viviera en el front, un POST a
 * mano entraría a la sala tres horas antes.
 *
 * `mediconnect-web/src/features/video/lib/joinWindow.ts` tiene la misma
 * constante para no pedirle al servidor permiso en cada tick del reloj. Si
 * cambia una, tiene que cambiar la otra.
 */
export const JOIN_OPENS_MINUTES_BEFORE = 10;

/**
 * Cuántos minutos DESPUÉS del final del turno sigue abierta la sala.
 *
 * El turno dura `duration_minutes`, pero una consulta que se extiende diez
 * minutos es normal y cortarla en el minuto exacto sería peor que el problema
 * que evita. El tope existe igual porque Daily factura por minuto de
 * participante: una sala que no cierra es una factura que no cierra.
 */
export const JOIN_GRACE_MINUTES_AFTER = 15;

/**
 * Estados del turno que habilitan entrar a la sala (ENG-147).
 *
 * Solo `CONFIRMADO`, que es el turno pagado. ENG-101 libera las reservas
 * impagas a los 15 minutos, pero lo hace un job que dispara un cron de GitHub,
 * y si el cron se atrasa queda una ventana en la que un turno sin pagar sigue
 * `RESERVADO_SIN_PAGAR` cuando abre la sala. Sin este recorte, el paciente se
 * atendería sin pagar.
 *
 * Sin excepciones (ENG-226): hasta ENG-226 los turnos impagos reservados antes
 * del deploy del cobro también entraban, por una fecha fija en el código. Era
 * una consulta gratis abierta para siempre; en prod ya no quedaba ninguno.
 */
export const JOINABLE_STATUSES = ['CONFIRMADO'] as const;

/** Si un turno en `status` puede entrar a la sala: solo el pagado. */
export function isJoinableStatus(status: string): boolean {
  return JOINABLE_STATUSES.includes(
    status as (typeof JOINABLE_STATUSES)[number],
  );
}

/**
 * Grabación de audio para el pipeline de transcripción (EP-07).
 *
 * `'cloud-audio-only'` es el valor de Daily que graba solo audio; `'off'`
 * desactiva la grabación por completo. El default es `'off'` **a propósito** y
 * está explicado en el informe del ticket: prender esto necesita (a) una base
 * legal y un consentimiento explícito del paciente por la Ley 25.326, que
 * todavía no existen, y (b) un plan pago de Daily, porque la grabación se
 * factura por minuto grabado más almacenamiento, y el proyecto corre en free
 * tier. El código está entero; lo que falta no es código.
 */
export type RecordingMode = 'off' | 'cloud-audio-only';

export const DEFAULT_RECORDING_MODE: RecordingMode = 'off';

/**
 * Propiedades de la sala de una consulta.
 *
 * Se partió de las del spike de Daily (ENG-51) y se cambiaron tres cosas, todas
 * por el mismo motivo —esto ya no es una prueba—:
 *
 * - `exp` sale del turno, no de un TTL fijo: la sala vive lo que dura la
 *   consulta más la tolerancia.
 * - `enable_chat: false`: el chat del Prebuilt es efímero y muere con la sala.
 *   En una prueba es una comodidad; en una consulta médica es un canal donde se
 *   puede escribir información clínica que después no queda en ningún lado y no
 *   entra en la historia clínica. El chat persistente del producto es EP-08.
 * - `enable_recording` según la configuración del entorno (ver arriba).
 */
export function consultationRoomProperties(
  expiresAtUnix: number,
  recording: RecordingMode,
) {
  return {
    exp: expiresAtUnix,
    eject_at_room_exp: true,
    // Paciente + profesional. Primera línea de defensa antes del token: si el
    // link se filtrara, un tercero no entra porque la sala ya está llena.
    max_participants: 2,
    enable_prejoin_ui: true,
    enable_network_ui: true,
    enable_screenshare: true,
    enable_chat: false,
    ...(recording === 'off'
      ? { enable_recording: false }
      : { enable_recording: recording }),
  };
}

/** Ventana en la que se puede entrar a la sala de un turno. */
export interface JoinWindow {
  opensAt: Date;
  closesAt: Date;
}

/**
 * Calcula la ventana de ingreso de un turno.
 *
 * Función pura y exportada para poder testear los bordes sin levantar Nest ni
 * tocar Daily: los tres casos que importan son "todavía no", "justo" y "ya no".
 */
export function joinWindowFor(
  scheduledAt: Date,
  durationMinutes: number,
): JoinWindow {
  const start = scheduledAt.getTime();
  return {
    opensAt: new Date(start - JOIN_OPENS_MINUTES_BEFORE * 60_000),
    closesAt: new Date(
      start + (durationMinutes + JOIN_GRACE_MINUTES_AFTER) * 60_000,
    ),
  };
}
