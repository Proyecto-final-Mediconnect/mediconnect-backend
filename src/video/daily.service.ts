import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DAILY_API_URL,
  ROOM_PROPERTIES,
  ROOM_TTL_SECONDS,
  SPIKE_ROOM_PREFIX,
  TOKEN_TTL_SECONDS,
} from './daily.config';

/**
 * Cliente de la API REST de Daily.co (ENG-51).
 *
 * Es a propósito un wrapper fino sobre `fetch`: el SDK de servidor de Daily
 * (`@daily-co/daily-js` es de cliente; el de servidor son llamadas HTTP planas)
 * no aporta nada acá y agregar una dependencia para tres endpoints es peor que
 * escribirlos. Node 22+ trae `fetch` global, así que tampoco hace falta axios
 * ni undici.
 *
 * Todas las llamadas salen con `Authorization: Bearer <DAILY_API_KEY>`. Esa key
 * es de **servidor** y no puede viajar al navegador: por eso el front nunca
 * habla con `api.daily.co`, sino con este backend (ver ADR-010 y el informe del
 * spike en mediconnect-docs).
 */

/** Cuánto se espera a Daily antes de cortar. Sin timeout, un incidente de su
 *  lado deja requests colgados ocupando conexiones del backend. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Sala de prueba lista para embeber, con un token por rol. */
export interface SpikeRoom {
  /** Nombre de la sala en Daily (único por dominio). */
  name: string;
  /** URL base de la sala, sin token. */
  url: string;
  /** Momento en que Daily expulsa a todos y la sala deja de aceptar entradas. */
  expiresAt: string;
  /** URL lista para el iframe, con el token del rol correspondiente. */
  professionalUrl: string;
  patientUrl: string;
  maxParticipants: number;
}

/** Resumen de una sesión ya terminada, para las métricas del criterio 3. */
export interface MeetingSession {
  id: string;
  room: string;
  startTime: string;
  /** Duración de la sesión en segundos, según Daily. */
  durationSeconds: number;
  /** Cantidad de participantes distintos que pasaron por la sesión. */
  participants: number;
  /** Minutos de participante facturables (suma de la permanencia de cada uno). */
  participantMinutes: number;
}

/** Respuesta de `POST /rooms`. Solo se tipa lo que se usa. */
interface DailyRoomResponse {
  name: string;
  url: string;
  config?: { exp?: number };
}

interface DailyTokenResponse {
  token: string;
}

interface DailyMeetingsResponse {
  data?: {
    id: string;
    room: string;
    start_time: number;
    duration: number;
    participants?: { participant_id: string; duration: number }[];
  }[];
}

@Injectable()
export class DailyService {
  private readonly logger = new Logger(DailyService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * `DAILY_API_KEY` es opcional en la validación de entorno (el backend tiene que
   * bootear en CI y en local sin credenciales de terceros), así que la ausencia
   * se detecta acá y se traduce a un 503 explicado en vez de un 401 de Daily.
   */
  isConfigured(): boolean {
    return Boolean(this.config.get<string>('DAILY_API_KEY'));
  }

  /**
   * Crea una sala privada de prueba y devuelve una URL por rol, ya tokenizada.
   *
   * **Privada, no pública.** Una sala pública es accesible por cualquiera que
   * tenga la URL, y la URL de una consulta médica termina en un historial de
   * navegación, en un chat o en un log. Con `privacy: 'private'` la URL sola no
   * alcanza: hace falta un meeting token firmado por el dominio, que solo emite
   * este backend. Es el flujo que va a necesitar ENG-56, y validarlo es la mitad
   * del valor de este spike.
   */
  async createSpikeRoom(userName: string): Promise<SpikeRoom> {
    this.assertConfigured();

    const now = Math.floor(Date.now() / 1000);
    const roomExp = now + ROOM_TTL_SECONDS;
    const tokenExp = now + TOKEN_TTL_SECONDS;

    const room = await this.request<DailyRoomResponse>('POST', '/rooms', {
      // Nombre único: dos pruebas en paralelo no se pisan, y el prefijo permite
      // barrer las salas del spike sin tocar ninguna otra.
      name: `${SPIKE_ROOM_PREFIX}-${crypto.randomUUID().slice(0, 8)}`,
      privacy: 'private',
      properties: { ...ROOM_PROPERTIES, exp: roomExp },
    });

    // Dos tokens, no uno: `is_owner` habilita los controles de moderación del
    // Prebuilt (expulsar, silenciar). En una consulta el profesional conduce y
    // el paciente no debería poder sacarlo de su propia sala.
    const [professionalToken, patientToken] = await Promise.all([
      this.createMeetingToken(
        room.name,
        `${userName} (profesional)`,
        true,
        tokenExp,
      ),
      this.createMeetingToken(
        room.name,
        `${userName} (paciente)`,
        false,
        tokenExp,
      ),
    ]);

    return {
      name: room.name,
      url: room.url,
      expiresAt: new Date(roomExp * 1000).toISOString(),
      professionalUrl: `${room.url}?t=${professionalToken}`,
      patientUrl: `${room.url}?t=${patientToken}`,
      maxParticipants: ROOM_PROPERTIES.max_participants,
    };
  }

  /**
   * Sesiones ya finalizadas de una sala, para el informe del spike.
   *
   * Daily publica los datos de una sesión recién cuando termina, así que esto
   * devuelve vacío mientras la llamada está en curso. No es un error: es cómo
   * funciona su API de analytics.
   */
  async getMeetingSessions(roomName: string): Promise<MeetingSession[]> {
    this.assertConfigured();

    const response = await this.request<DailyMeetingsResponse>(
      'GET',
      `/meetings?room=${encodeURIComponent(roomName)}&limit=100`,
    );

    return (response.data ?? []).map((session) => {
      const participants = session.participants ?? [];
      return {
        id: session.id,
        room: session.room,
        startTime: new Date(session.start_time * 1000).toISOString(),
        durationSeconds: session.duration,
        participants: participants.length,
        // Daily factura por minuto de participante, no por minuto de sala: una
        // llamada de 30 min entre dos personas consume 60. El informe del spike
        // necesita este número para proyectar el costo del MVP.
        participantMinutes: Math.round(
          participants.reduce((total, p) => total + p.duration, 0) / 60,
        ),
      };
    });
  }

  /** Borra una sala de prueba. Daily responde 404 si ya no existe; se trata como
   *  éxito porque el objetivo (que no quede la sala) está cumplido igual. */
  async deleteRoom(roomName: string): Promise<void> {
    this.assertConfigured();

    try {
      await this.request('DELETE', `/rooms/${encodeURIComponent(roomName)}`);
    } catch (error) {
      if (error instanceof DailyApiError && error.dailyStatus === 404) return;
      throw error;
    }
  }

  private createMeetingToken(
    roomName: string,
    userName: string,
    isOwner: boolean,
    exp: number,
  ): Promise<string> {
    return this.request<DailyTokenResponse>('POST', '/meeting-tokens', {
      properties: {
        room_name: roomName,
        user_name: userName,
        is_owner: isOwner,
        exp,
      },
    }).then((response) => response.token);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'La integración con Daily.co no está configurada en este entorno (falta DAILY_API_KEY).',
      );
    }
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const apiKey = this.config.getOrThrow<string>('DAILY_API_KEY');
    const baseUrl = this.config.get<string>('DAILY_API_URL') ?? DAILY_API_URL;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // Timeout o fallo de red. El mensaje del `cause` no se propaga al cliente:
      // puede traer la URL interna, y al usuario no le dice nada.
      this.logger.error(`Daily ${method} ${path} falló: ${String(cause)}`);
      throw new DailyApiError(
        0,
        HttpStatus.SERVICE_UNAVAILABLE,
        'No pudimos comunicarnos con Daily.co. Probá de nuevo en unos minutos.',
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(
        `Daily ${method} ${path} devolvió ${response.status}: ${detail.slice(0, 300)}`,
      );
      throw new DailyApiError(
        response.status,
        // Siempre 502, nunca el status de Daily tal cual: un 401 de Daily (API
        // key vencida) propagado como 401 haría que la web crea que venció la
        // sesión del usuario e intente renovarla en loop. El problema es del
        // proveedor, y así se comunica.
        HttpStatus.BAD_GATEWAY,
        `Daily.co rechazó la operación (HTTP ${response.status}).`,
      );
    }

    // DELETE /rooms/:name devuelve un cuerpo mínimo y algunos endpoints no
    // devuelven nada; parsear a la fuerza rompería con un 204.
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/**
 * Fallo hablando con Daily. Es una `HttpException` para que Nest la serialice
 * sola (si fuera un `Error` pelado saldría como 500 genérico), y guarda aparte
 * el status que devolvió Daily para poder distinguir un 404 esperado (sala ya
 * borrada) de un fallo real. `dailyStatus` en 0 significa que no hubo respuesta:
 * timeout o error de red.
 */
export class DailyApiError extends HttpException {
  constructor(
    readonly dailyStatus: number,
    exposedStatus: HttpStatus,
    message: string,
  ) {
    super(message, exposedStatus);
    this.name = 'DailyApiError';
  }
}
