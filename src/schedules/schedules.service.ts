import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ProfessionalCancellationService,
  type ProfessionalCancellationResult,
} from '../appointments/professional-cancellation.service';
import { toLocalDateTime } from '../common/time/argentina-time';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  blocksOverlap,
  blockWindow,
  type BlockWindow,
  MAX_APPOINTMENT_MINUTES,
  overlaps,
} from './block-affected';
import { CreateScheduleBlockDto } from './dto/create-schedule-block.dto';
import { SaveScheduleDto } from './dto/save-schedule.dto';
import {
  findOverlappingRules,
  fromSqlTime,
  toSqlTime,
  validateWindow,
  WEEKDAY_NAMES,
} from './schedule.rules';

/** Cliente Supabase scopeado al JWT del profesional (RLS evalúa `auth.uid()`).
 *  Se crea UNO por request y se pasa a los helpers. */
type UserClient = ReturnType<SupabaseService['getClientForToken']>;

const RULE_SELECT = 'id, weekday, start_time, end_time, slot_duration_minutes';
const BLOCK_SELECT = 'id, block_date, start_time, end_time, reason';

/** Fila cruda de `schedule_rules`. */
interface ScheduleRuleRow {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  slot_duration_minutes: number;
}

/** Fila cruda de `schedule_blocks`. */
interface ScheduleBlockRow {
  id: string;
  block_date: string;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
}

/** Franja de atención expuesta por la API (camelCase, horas en `HH:MM`). */
export interface ScheduleRule {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  slotDurationMinutes: number;
}

/** Bloqueo expuesto por la API. `startTime`/`endTime` en null = día completo. */
export interface ScheduleBlock {
  id: string;
  blockDate: string;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
}

export interface Schedule {
  rules: ScheduleRule[];
  blocks: ScheduleBlock[];
}

/** Un turno que pisa un bloqueo (ENG-206), como se le muestra al profesional. */
export interface AffectedAppointment {
  id: string;
  scheduledAt: string;
  /** Fecha y hora locales (Argentina). */
  date: string;
  startTime: string;
  durationMinutes: number;
  status: string;
  /** Pagado: el paciente va a poder elegir otro horario o el 100 %. */
  paid: boolean;
  patient: { firstName: string; lastName: string } | null;
}

/** El bloqueo creado y los turnos que canceló (ENG-206). */
export interface CreatedBlock extends ScheduleBlock {
  cancelledAppointments: ProfessionalCancellationResult[];
}

/** Motivo para un turno que se reservó en el instante en que se creaba el bloqueo. */
const LATE_BOOKING_REASON =
  'El profesional bloqueó ese horario justo cuando se reservaba el turno.';

/** Fila de turno que lee el cálculo de afectados. */
interface AffectedRow {
  id: string;
  professional_id: string;
  status: string;
  scheduled_at: Date;
  duration_minutes: number;
  patient: { first_name: string; last_name: string } | null;
}

@Injectable()
export class SchedulesService {
  private readonly logger = new Logger(SchedulesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly prisma: PrismaService,
    private readonly cancellation: ProfessionalCancellationService,
  ) {}

  /** Agenda del profesional autenticado: franjas semanales + bloqueos vigentes. */
  async getMySchedule(accessToken: string, userId: string): Promise<Schedule> {
    const client = this.supabase.getClientForToken(accessToken);
    return this.readSchedule(client, userId);
  }

  /**
   * Reemplaza la agenda semanal completa (delete + insert), igual que el manejo
   * de especialidades de ENG-48. Mandar `rules: []` deja la agenda vacía a
   * propósito: es cómo el profesional deja de publicar disponibilidad.
   */
  async saveMyRules(
    accessToken: string,
    userId: string,
    dto: SaveScheduleDto,
  ): Promise<Schedule> {
    this.assertRulesAreCoherent(dto);

    const client = this.supabase.getClientForToken(accessToken);
    await this.assertProfileExists(
      client,
      userId,
      'No pudimos guardar tu agenda. Probá de nuevo en unos minutos.',
    );

    // Sin transacción entre el delete y el insert — misma decisión (y mismo
    // riesgo asumido) que `replaceSpecialties` en ENG-48: PostgREST no expone
    // transacciones multi-request. Si el insert falla, el profesional queda con
    // la agenda vacía y reintenta guardando de nuevo; ninguna reserva existente
    // se pierde, porque los turnos viven en `appointments`, no acá.
    const { error: deleteError } = await client
      .from('schedule_rules')
      .delete()
      .eq('professional_id', userId);

    if (deleteError) {
      throw new InternalServerErrorException(
        'No pudimos guardar tu agenda. Probá de nuevo en unos minutos.',
      );
    }

    if (dto.rules.length > 0) {
      const rows = dto.rules.map((rule) => ({
        professional_id: userId,
        weekday: rule.weekday,
        start_time: toSqlTime(rule.startTime),
        end_time: toSqlTime(rule.endTime),
        slot_duration_minutes: rule.slotDurationMinutes,
      }));

      const { error: insertError } = await client
        .from('schedule_rules')
        .insert(rows);

      if (insertError) {
        throw new InternalServerErrorException(
          'No pudimos guardar tu agenda. Probá de nuevo en unos minutos.',
        );
      }
    }

    return this.readSchedule(
      client,
      userId,
      'Guardamos tu agenda, pero no pudimos volver a leerla. Recargá la página.',
    );
  }

  /**
   * Qué turnos pisaría el bloqueo, sin crearlo (ENG-206).
   */
  async previewBlock(
    accessToken: string,
    userId: string,
    dto: CreateScheduleBlockDto,
    now: Date = new Date(),
  ): Promise<{ affected: AffectedAppointment[] }> {
    this.assertBlockShape(dto);
    await this.assertProfileExists(
      this.supabase.getClientForToken(accessToken),
      userId,
      'No pudimos revisar tu agenda. Probá de nuevo en unos minutos.',
    );
    const window = blockWindow(dto.blockDate, dto.startTime, dto.endTime);
    const affected = await this.findAffected(userId, window, now);
    return { affected: affected.map(toAffectedView) };
  }

  /**
   * Crea un bloqueo puntual (día completo o una franja de ese día).
   *
   * ## Con turnos tomados (ENG-206, ADR-018 caso 1)
   *
   * Un turno vigente que se superpone con el bloqueo no puede quedar activo en
   * un horario en el que el profesional no está:
   *
   * - Sin `cancelAffected`, da **409 con la lista** de turnos: nunca se cancela
   *   un turno que el profesional no vio.
   * - Con `cancelAffected` y `cancellationReason`, el bloqueo y la cancelación
   *   de cada turno van en **una sola transacción**: los pagados pasan a
   *   `A_REPROGRAMAR` y las reservas sin pagar a `CANCELADO`, igual que si los
   *   cancelara uno por uno. Si algún turno cambió en el medio, no se guarda
   *   nada y da 409.
   * - Después del commit salen los avisos y, por si alguien reservó en ese
   *   horario justo mientras se creaba el bloqueo, una segunda pasada cancela
   *   lo que haya entrado.
   *
   * Borrar el bloqueo después no restaura los turnos cancelados: cada paciente
   * ya eligió (o está eligiendo) otro horario o el reembolso.
   */
  async createBlock(
    accessToken: string,
    userId: string,
    dto: CreateScheduleBlockDto,
    now: Date = new Date(),
  ): Promise<CreatedBlock> {
    this.assertBlockShape(dto);
    const client = this.supabase.getClientForToken(accessToken);
    await this.assertProfileExists(
      client,
      userId,
      'No pudimos guardar el bloqueo. Probá de nuevo en unos minutos.',
    );

    const window = blockWindow(dto.blockDate, dto.startTime, dto.endTime);
    const affected = await this.findAffected(userId, window, now);
    if (affected.length > 0 && !dto.cancelAffected) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'BLOCK_HAS_APPOINTMENTS',
        message:
          affected.length === 1
            ? 'Ese horario tiene un turno tomado. Confirmá que querés cancelarlo.'
            : `Ese horario tiene ${affected.length} turnos tomados. Confirmá que querés cancelarlos.`,
        affected: affected.map(toAffectedView),
      });
    }
    if (affected.length > 0 && !dto.cancellationReason) {
      throw new BadRequestException(
        'Contales a los pacientes por qué cancelás: el motivo es obligatorio.',
      );
    }

    let created: {
      id: string;
      block_date: Date;
      start_time: Date | null;
      end_time: Date | null;
      reason: string | null;
    };
    let cancelled: ProfessionalCancellationResult[];
    try {
      ({ created, cancelled } = await this.prisma.$transaction(
        async (tx) => {
          const sameDay = await tx.scheduleBlock.findMany({
            where: {
              professional_id: userId,
              block_date: new Date(`${dto.blockDate}T00:00:00.000Z`),
            },
            select: { start_time: true, end_time: true },
          });
          const incoming = {
            startTime: dto.startTime ?? null,
            endTime: dto.endTime ?? null,
          };
          if (
            sameDay.some((b) => blocksOverlap(fromPrismaTimes(b), incoming))
          ) {
            throw new ConflictException(
              'Ya tenés un bloqueo que se superpone con ese horario ese día.',
            );
          }

          const block = await tx.scheduleBlock.create({
            data: {
              professional_id: userId,
              block_date: new Date(`${dto.blockDate}T00:00:00.000Z`),
              start_time: dto.startTime ? toPrismaTime(dto.startTime) : null,
              end_time: dto.endTime ? toPrismaTime(dto.endTime) : null,
              reason: dto.reason ?? null,
            },
            select: {
              id: true,
              block_date: true,
              start_time: true,
              end_time: true,
              reason: true,
            },
          });

          const results: ProfessionalCancellationResult[] = [];
          for (const a of affected) {
            results.push(
              await this.cancellation.applyCancellation(
                tx,
                a,
                dto.cancellationReason!,
                userId,
                now,
                'BLOQUEO',
              ),
            );
          }
          return { created: block, cancelled: results };
        },
        // Un bloqueo de un día con muchos turnos son varias escrituras.
        { timeout: 20_000 },
      ));
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        throw new ConflictException('Ese bloqueo ya está cargado.');
      }
      if (code === 'P2025') {
        throw new ConflictException(
          'Un turno de ese horario cambió mientras lo bloqueabas. Revisá la lista y probá de nuevo.',
        );
      }
      this.logger.error(`No se pudo crear el bloqueo: ${String(err)}`);
      throw new InternalServerErrorException(
        'No pudimos guardar el bloqueo. Probá de nuevo en unos minutos.',
      );
    }

    for (const result of cancelled) {
      await this.cancellation.afterCancellation(result, now);
    }
    cancelled.push(
      ...(await this.cancelLateBookings(
        userId,
        window,
        dto.cancellationReason ?? LATE_BOOKING_REASON,
        now,
      )),
    );

    return {
      id: created.id,
      blockDate: created.block_date.toISOString().slice(0, 10),
      startTime: created.start_time?.toISOString().slice(11, 16) ?? null,
      endTime: created.end_time?.toISOString().slice(11, 16) ?? null,
      reason: created.reason,
      cancelledAppointments: cancelled,
    };
  }

  /**
   * Segunda pasada después del commit (ENG-206): un turno que se reservó en ese
   * horario mientras se creaba el bloqueo pasó la validación de disponibilidad
   * antes de que el bloqueo existiera. Se cancela igual que los demás. Nunca
   * tira: el bloqueo ya está guardado.
   */
  private async cancelLateBookings(
    userId: string,
    window: BlockWindow,
    reason: string,
    now: Date,
  ): Promise<ProfessionalCancellationResult[]> {
    const results: ProfessionalCancellationResult[] = [];
    try {
      for (const a of await this.findAffected(userId, window, now)) {
        try {
          const result = await this.prisma.$transaction((tx) =>
            this.cancellation.applyCancellation(
              tx,
              a,
              reason,
              userId,
              now,
              'BLOQUEO',
            ),
          );
          await this.cancellation.afterCancellation(result, now);
          results.push(result);
        } catch (err) {
          this.logger.error(
            `Bloqueo: no se pudo cancelar el turno ${a.id} que entró tarde: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Bloqueo: falló la segunda pasada: ${String(err)}`);
    }
    return results;
  }

  /** Turnos vigentes y futuros del profesional que se superponen con la ventana. */
  private async findAffected(
    userId: string,
    window: BlockWindow,
    now: Date,
  ): Promise<AffectedRow[]> {
    const rows = await this.prisma.appointment.findMany({
      where: {
        professional_id: userId,
        status: { in: ['RESERVADO_SIN_PAGAR', 'CONFIRMADO'] },
        // Los que ya empezaron no: la ausencia del profesional es ENG-237.
        scheduled_at: {
          gt: now,
          gte: new Date(
            window.start.getTime() - MAX_APPOINTMENT_MINUTES * 60_000,
          ),
          lt: window.end,
        },
      },
      select: {
        id: true,
        professional_id: true,
        status: true,
        scheduled_at: true,
        duration_minutes: true,
        patient: { select: { first_name: true, last_name: true } },
      },
      orderBy: { scheduled_at: 'asc' },
    });
    return rows.filter((r) =>
      overlaps(window, r.scheduled_at, r.duration_minutes),
    );
  }

  /** Forma del bloqueo: las dos horas juntas o ninguna, y una ventana válida. */
  private assertBlockShape(dto: CreateScheduleBlockDto): void {
    const hasStart = dto.startTime !== undefined;
    const hasEnd = dto.endTime !== undefined;

    // Espejo del CHECK `schedule_blocks_time_range_check`: se valida acá para
    // poder explicar el caso en vez de devolver un error crudo de Postgres.
    if (hasStart !== hasEnd) {
      throw new BadRequestException(
        'Para bloquear una franja horaria indicá la hora de inicio y la de fin. Si querés bloquear el día completo, no mandes ninguna de las dos.',
      );
    }

    if (hasStart && hasEnd) {
      const error = validateWindow({
        startTime: dto.startTime!,
        endTime: dto.endTime!,
      });
      if (error) throw new BadRequestException(error);
    }
  }

  /** Borra un bloqueo propio. RLS ya impide tocar los de otro profesional; el
   *  `eq` explícito hace que el 404 sea correcto en vez de un 204 engañoso. */
  async deleteBlock(
    accessToken: string,
    userId: string,
    blockId: string,
  ): Promise<void> {
    const client = this.supabase.getClientForToken(accessToken);

    const { data, error } = await client
      .from('schedule_blocks')
      .delete()
      .eq('id', blockId)
      .eq('professional_id', userId)
      .select('id');

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos borrar el bloqueo. Probá de nuevo en unos minutos.',
      );
    }

    if (!data || data.length === 0) {
      throw new NotFoundException(
        'No se encontró el bloqueo que querés borrar.',
      );
    }
  }

  /** Validaciones que la base no puede expresar: ventana coherente y sin solapes. */
  private assertRulesAreCoherent(dto: SaveScheduleDto): void {
    for (const rule of dto.rules) {
      const error = validateWindow(rule, rule.slotDurationMinutes);
      if (error) {
        throw new BadRequestException(
          `${capitalize(WEEKDAY_NAMES[rule.weekday])}: ${error}`,
        );
      }
    }

    const overlap = findOverlappingRules(dto.rules);
    if (overlap) {
      const [first, second] = overlap;
      throw new BadRequestException(
        `Las franjas del ${WEEKDAY_NAMES[first.weekday]} se superponen: ${first.startTime}-${first.endTime} y ${second.startTime}-${second.endTime}.`,
      );
    }
  }

  private async readSchedule(
    client: UserClient,
    userId: string,
    onReadError = 'No pudimos cargar tu agenda. Probá de nuevo en unos minutos.',
  ): Promise<Schedule> {
    const [rulesResult, blocksResult] = await Promise.all([
      client
        .from('schedule_rules')
        .select(RULE_SELECT)
        .eq('professional_id', userId)
        .order('weekday')
        .order('start_time'),
      client
        .from('schedule_blocks')
        .select(BLOCK_SELECT)
        .eq('professional_id', userId)
        // Los bloqueos pasados no se muestran: no afectan ninguna reserva futura
        // y ensuciarían la lista para siempre. Quedan en la base como registro.
        .gte('block_date', today())
        .order('block_date')
        .order('start_time', { nullsFirst: true }),
    ]);

    if (rulesResult.error || blocksResult.error) {
      throw new InternalServerErrorException(onReadError);
    }

    const ruleRows = (rulesResult.data ?? []) as unknown as ScheduleRuleRow[];
    const blockRows = (blocksResult.data ??
      []) as unknown as ScheduleBlockRow[];

    return {
      rules: ruleRows.map((row) => this.toRule(row)),
      blocks: blockRows.map((row) => this.toBlock(row)),
    };
  }

  /** Confirma que el usuario tenga perfil profesional antes de escribir; da un
   *  404 claro si un paciente llamara estos endpoints. */
  private async assertProfileExists(
    client: UserClient,
    userId: string,
    onError: string,
  ): Promise<void> {
    const { data, error } = await client
      .from('professionals')
      .select('profile_id')
      .eq('profile_id', userId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(onError);
    }
    if (!data) {
      throw new NotFoundException('No se encontró tu perfil profesional.');
    }
  }

  private toRule(row: ScheduleRuleRow): ScheduleRule {
    return {
      id: row.id,
      weekday: row.weekday,
      startTime: fromSqlTime(row.start_time),
      endTime: fromSqlTime(row.end_time),
      slotDurationMinutes: row.slot_duration_minutes,
    };
  }

  private toBlock(row: ScheduleBlockRow): ScheduleBlock {
    return {
      id: row.id,
      blockDate: row.block_date,
      startTime: row.start_time ? fromSqlTime(row.start_time) : null,
      endTime: row.end_time ? fromSqlTime(row.end_time) : null,
      reason: row.reason,
    };
  }
}

/**
 * Fecha de hoy en `YYYY-MM-DD`, para filtrar bloqueos vencidos.
 *
 * En hora de Argentina, NO en UTC: `toISOString()` daría la fecha UTC y el
 * backend corre en Render (UTC). Entre las 21:00 y la medianoche de acá, la
 * fecha UTC ya es la de mañana, así que los bloqueos del día en curso
 * desaparecerían de la lista tres horas antes de que el día termine.
 *
 * `en-CA` se usa porque formatea como `YYYY-MM-DD`, que es justo lo que espera
 * la columna `date`. La zona está fija porque el MVP es solo Argentina (misma
 * premisa que `currency = 'ARS'`); cuando haya profesionales en otra zona, esto
 * pasa a salir del perfil.
 */
const AR_TIMEZONE = 'America/Argentina/Buenos_Aires';

/**
 * Se arma con `formatToParts` en vez de confiar en que un locale imprima
 * `YYYY-MM-DD`: si Node se compila sin ICU completo, `en-CA` cae a `en-US` y
 * pasa a devolver `MM/DD/YYYY`. El filtro de bloqueos seguiría corriendo, pero
 * comparando basura contra una columna `date` — el tipo de falla que no se ve
 * hasta que alguien nota que los bloqueos no aparecen.
 */
const AR_DATE_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: AR_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function today(): string {
  const parts = Object.fromEntries(
    AR_DATE_PARTS.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** `HH:MM` → la `Date` con que Prisma escribe una columna `time` (1970-01-01, UTC). */
function toPrismaTime(time: string): Date {
  return new Date(`1970-01-01T${time}:00.000Z`);
}

/** Las horas de un bloqueo leído por Prisma, en `HH:MM`. */
function fromPrismaTimes(b: {
  start_time: Date | null;
  end_time: Date | null;
}): {
  startTime: string | null;
  endTime: string | null;
} {
  return {
    startTime: b.start_time?.toISOString().slice(11, 16) ?? null,
    endTime: b.end_time?.toISOString().slice(11, 16) ?? null,
  };
}

function toAffectedView(row: AffectedRow): AffectedAppointment {
  const { date, startTime } = toLocalDateTime(row.scheduled_at);
  return {
    id: row.id,
    scheduledAt: row.scheduled_at.toISOString(),
    date,
    startTime,
    durationMinutes: row.duration_minutes,
    status: row.status,
    paid: row.status === 'CONFIRMADO',
    patient: row.patient
      ? { firstName: row.patient.first_name, lastName: row.patient.last_name }
      : null,
  };
}
