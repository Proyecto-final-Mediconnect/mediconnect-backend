import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
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

/** `23505 unique_violation` de Postgres, que PostgREST propaga tal cual. */
const UNIQUE_VIOLATION = '23505';

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

@Injectable()
export class SchedulesService {
  constructor(private readonly supabase: SupabaseService) {}

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

  /** Crea un bloqueo puntual (día completo o una franja de ese día). */
  async createBlock(
    accessToken: string,
    userId: string,
    dto: CreateScheduleBlockDto,
  ): Promise<ScheduleBlock> {
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

    const client = this.supabase.getClientForToken(accessToken);
    await this.assertProfileExists(
      client,
      userId,
      'No pudimos guardar el bloqueo. Probá de nuevo en unos minutos.',
    );

    const { data, error } = await client
      .from('schedule_blocks')
      .insert({
        professional_id: userId,
        block_date: dto.blockDate,
        start_time: hasStart ? toSqlTime(dto.startTime!) : null,
        end_time: hasEnd ? toSqlTime(dto.endTime!) : null,
        reason: dto.reason ?? null,
      })
      .select(BLOCK_SELECT)
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        throw new ConflictException('Ese bloqueo ya está cargado.');
      }
      throw new InternalServerErrorException(
        'No pudimos guardar el bloqueo. Probá de nuevo en unos minutos.',
      );
    }

    return this.toBlock(data as unknown as ScheduleBlockRow);
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
