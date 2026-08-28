import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  DEFAULT_RECORDING_MODE,
  JOINABLE_STATUSES,
  JOIN_OPENS_MINUTES_BEFORE,
  joinWindowFor,
  type RecordingMode,
} from './consultation.config';
import { DailyService } from './daily.service';

/**
 * Ingreso a la videoconsulta de un turno (ENG-56).
 *
 * Un solo caso de uso —"dame la sala de este turno"— con cuatro reglas que se
 * validan siempre del lado del servidor:
 *
 * 1. El turno existe y quien pide participa de él.
 * 2. El turno está activo (no cancelado ni liberado).
 * 3. Estamos dentro de la ventana horaria.
 * 4. La sala se crea una sola vez, la use quien la use primero.
 *
 * La autorización sigue el patrón del proyecto: el turno se lee **por PostgREST
 * con el JWT del usuario**, así que quien decide si lo ve es la política
 * `appointments_select_own` y no una comparación de ids de este service. Las
 * escrituras van por Prisma (owner) porque `consultations` y `video_sessions` no
 * tienen —ni deben tener— GRANTs para `authenticated`.
 */

/** Rol de quien entra a la sala. Sale del turno, no del JWT: la misma persona
 *  podría ser profesional en un turno y paciente en otro. */
export type ConsultationRole = 'PACIENTE' | 'PROFESIONAL';

export interface VideoConsultationAccess {
  appointmentId: string;
  role: ConsultationRole;
  /** URL de la sala **con** el meeting token. Es efímera: no se persiste. */
  roomUrl: string;
  /** Cuándo Daily cierra la sala y expulsa a todos. */
  expiresAt: string;
  /** La otra persona de la consulta, para el encabezado de la pantalla. */
  counterpart: { firstName: string; lastName: string } | null;
  recording: {
    /**
     * Si esta sala graba el audio de la consulta. El paciente tiene derecho a
     * saberlo, así que la pantalla muestra un aviso u otro según este valor.
     */
    enabled: boolean;
    mode: RecordingMode;
  };
}

/** Fila de `appointments` que necesita este flujo. */
interface AppointmentRow {
  id: string;
  patient_id: string;
  professional_id: string;
  scheduled_at: string;
  duration_minutes: number;
  status: string;
}

const APPOINTMENT_SELECT =
  'id, patient_id, professional_id, scheduled_at, duration_minutes, status';

@Injectable()
export class VideoConsultationService {
  private readonly logger = new Logger(VideoConsultationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly daily: DailyService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Devuelve la URL tokenizada de la sala del turno, creándola si quien pide es
   * el primero de los dos en entrar.
   */
  async join(
    accessToken: string,
    userId: string,
    appointmentId: string,
    now: Date = new Date(),
  ): Promise<VideoConsultationAccess> {
    const appointment = await this.readAppointment(accessToken, appointmentId);
    const role = this.resolveRole(appointment, userId);

    this.assertJoinable(appointment, now);

    const { closesAt } = joinWindowFor(
      new Date(appointment.scheduled_at),
      appointment.duration_minutes,
    );
    const recording = this.recordingMode();
    const expiresAtUnix = Math.floor(closesAt.getTime() / 1000);

    const room = await this.ensureRoom(
      appointment,
      expiresAtUnix,
      recording,
      now,
    );

    const token = await this.daily.createConsultationToken({
      roomName: room.name,
      // El nombre que ven los demás dentro de la sala. Se usa el ROL y no el
      // nombre propio: en una consulta las dos partes ya saben quién es la otra,
      // y el nombre real del profesional viajaría dentro del meeting token, que
      // es un JWT que el navegador puede leer.
      userName: role === 'PROFESIONAL' ? 'Profesional' : 'Paciente',
      isOwner: role === 'PROFESIONAL',
      expiresAtUnix,
      // Solo el profesional dispara la grabación: es quien responde por el
      // tratamiento de los datos clínicos.
      startRecording: role === 'PROFESIONAL' && recording !== 'off',
    });

    return {
      appointmentId: appointment.id,
      role,
      roomUrl: `${room.url}?t=${token}`,
      expiresAt: closesAt.toISOString(),
      counterpart: await this.findCounterpart(appointment, role),
      recording: { enabled: recording !== 'off', mode: recording },
    };
  }

  /**
   * Lee el turno con el JWT del usuario. RLS es la autorización: si el turno es
   * de otras dos personas, no hay fila y la respuesta es 404. Un 403 confirmaría
   * que ese id existe.
   */
  private async readAppointment(
    accessToken: string,
    appointmentId: string,
  ): Promise<AppointmentRow> {
    const client = this.supabase.getClientForToken(accessToken);

    const { data, error } = await client
      .from('appointments')
      .select(APPOINTMENT_SELECT)
      .eq('id', appointmentId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos abrir la videoconsulta. Probá de nuevo en unos minutos.',
      );
    }
    if (!data) {
      throw new NotFoundException('Ese turno no existe.');
    }

    return data as unknown as AppointmentRow;
  }

  /**
   * `appointments_select_own` ya garantiza que quien llegó acá participa del
   * turno, así que esta excepción no debería alcanzarse nunca. Se deja explícita
   * en vez de asumirla: si algún día se ampliara la policy (un moderador viendo
   * turnos ajenos, por ejemplo), el resultado sería un 403 y no un ingreso
   * silencioso a la consulta médica de otras dos personas.
   */
  private resolveRole(
    appointment: AppointmentRow,
    userId: string,
  ): ConsultationRole {
    if (appointment.patient_id === userId) return 'PACIENTE';
    if (appointment.professional_id === userId) return 'PROFESIONAL';

    throw new ForbiddenException(
      'Solo el paciente y el profesional del turno pueden entrar a la videoconsulta.',
    );
  }

  /** Estado y ventana horaria. Los mensajes son los que ve el usuario. */
  private assertJoinable(appointment: AppointmentRow, now: Date): void {
    if (
      !JOINABLE_STATUSES.includes(
        appointment.status as (typeof JOINABLE_STATUSES)[number],
      )
    ) {
      throw new ConflictException(
        'Ese turno ya no está activo, así que no tiene videoconsulta.',
      );
    }

    const { opensAt, closesAt } = joinWindowFor(
      new Date(appointment.scheduled_at),
      appointment.duration_minutes,
    );

    if (now < opensAt) {
      throw new ConflictException(
        `La sala se abre ${JOIN_OPENS_MINUTES_BEFORE} minutos antes del turno.`,
      );
    }
    if (now > closesAt) {
      throw new ConflictException('La videoconsulta de ese turno ya terminó.');
    }
  }

  /**
   * Sala del turno: la crea el primero de los dos que entra y la reusa el
   * segundo.
   *
   * Las dos filas intermedias existen porque el modelo las pide:
   * `video_sessions` cuelga de `consultations`, no de `appointments`. La
   * consulta es la unidad clínica —de ella cuelgan también las entradas de
   * historia clínica (ENG-58) y el resumen de IA (EP-07)—, así que crearla acá
   * no es un rodeo: es el momento en que la consulta efectivamente empieza.
   *
   * La carrera es real y esperable: paciente y profesional entrando a la vez a
   * las 15:00 en punto. Se resuelve con las unique que ya existen desde EP-02
   * (`consultations.appointment_id`, `video_sessions.consultation_id`) más un
   * update condicional para la sala, en vez de con un lock.
   */
  private async ensureRoom(
    appointment: AppointmentRow,
    expiresAtUnix: number,
    recording: RecordingMode,
    now: Date,
  ): Promise<{ name: string; url: string }> {
    const consultation = await this.prisma.consultation.upsert({
      where: { appointment_id: appointment.id },
      create: { appointment_id: appointment.id, started_at: now },
      // `update: {}` es un no-op deliberado: si la consulta ya existe se deja
      // como está. `started_at` marca cuándo empezó, no cuándo entró el último.
      update: {},
      select: { id: true },
    });

    const session = await this.prisma.videoSession.upsert({
      where: { consultation_id: consultation.id },
      create: {
        consultation_id: consultation.id,
        status: 'EN_CURSO',
        started_at: now,
      },
      update: {},
      select: { id: true, daily_room_name: true, daily_room_url: true },
    });

    if (session.daily_room_name && session.daily_room_url) {
      return { name: session.daily_room_name, url: session.daily_room_url };
    }

    const room = await this.daily.createConsultationRoom(
      expiresAtUnix,
      recording,
    );

    // Condicional a propósito: si entre el `upsert` y este update el otro
    // participante ya guardó SU sala, este `updateMany` afecta 0 filas y no la
    // pisa. Un `update` normal dejaría a los dos en salas distintas, cada uno
    // hablándole a nadie — el peor resultado posible de esta carrera.
    const claimed = await this.prisma.videoSession.updateMany({
      where: { id: session.id, daily_room_name: null },
      data: { daily_room_name: room.name, daily_room_url: room.url },
    });

    if (claimed.count === 1) return room;

    // Perdimos la carrera: la sala que acabamos de crear no la va a usar nadie.
    // Se borra porque Daily factura por minuto de participante y una sala
    // huérfana con `exp` lejano es cuota reservada al pedo. Si el borrado falla
    // no se corta el ingreso: la sala expira sola.
    void this.daily
      .deleteRoom(room.name)
      .catch((error: unknown) =>
        this.logger.warn(
          `No se pudo borrar la sala huérfana ${room.name}: ${String(error)}`,
        ),
      );

    const winner = await this.prisma.videoSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { daily_room_name: true, daily_room_url: true },
    });

    if (!winner.daily_room_name || !winner.daily_room_url) {
      throw new InternalServerErrorException(
        'No pudimos abrir la sala de la videoconsulta. Probá de nuevo en unos minutos.',
      );
    }

    return { name: winner.daily_room_name, url: winner.daily_room_url };
  }

  /**
   * Nombre de la otra persona, para el encabezado de la pantalla.
   *
   * Se lee por Prisma y no por PostgREST por el mismo motivo que en
   * `AppointmentsService.toViews`: RLS solo deja a cada uno leer su propia fila
   * de `patients` / `professionals`, así que un embed devolvería `null`. La
   * autorización ya la hizo RLS al decidir que este usuario ve este turno.
   */
  private async findCounterpart(
    appointment: AppointmentRow,
    role: ConsultationRole,
  ): Promise<{ firstName: string; lastName: string } | null> {
    const row =
      role === 'PACIENTE'
        ? await this.prisma.professional.findUnique({
            where: { profile_id: appointment.professional_id },
            select: { first_name: true, last_name: true },
          })
        : await this.prisma.patient.findUnique({
            where: { profile_id: appointment.patient_id },
            select: { first_name: true, last_name: true },
          });

    return row ? { firstName: row.first_name, lastName: row.last_name } : null;
  }

  /**
   * Modo de grabación del entorno. Cualquier valor que no sea exactamente
   * `cloud-audio-only` cae en `off`: ante una variable mal escrita, la opción
   * segura es no grabar.
   */
  private recordingMode(): RecordingMode {
    return this.config.get<string>('VIDEO_RECORDING_MODE') ===
      'cloud-audio-only'
      ? 'cloud-audio-only'
      : DEFAULT_RECORDING_MODE;
  }
}
