import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentPaymentService } from '../payments/appointment-payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  addDays,
  daysBetween,
  toInstant,
  toLocalDateTime,
  todayInArgentina,
} from '../common/time/argentina-time';
import {
  buildAvailability,
  findSlot,
  type AvailabilityBlock,
  type AvailabilityDay,
  type AvailabilityRule,
  type BusySlot,
} from './availability.rules';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';
import { holdExpiresAt, UNPAID_HOLD_MS } from './unpaid-hold';
import { CancellationPolicyService } from '../professionals/cancellation-policy.service';
import { refundPercentFor } from '../professionals/cancellation-policy';
import { UnpaidReleaseService } from './unpaid-release.service';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';

/**
 * Ver disponibilidad y reservar un turno (ENG-54).
 *
 * Usa los DOS caminos de datos del proyecto, y cuál se usa para qué no es
 * arbitrario:
 *
 * - **Prisma (owner)** para calcular la disponibilidad. Es información pública
 *   derivada — horarios libres de un profesional publicado —, el mismo criterio
 *   con el que ENG-49 sirve el catálogo. Evita tener que abrir por RLS la lectura
 *   de `schedule_rules`, `schedule_blocks` y `appointments` a todo usuario
 *   logueado, que expondría la agenda completa de cada profesional y los turnos de
 *   otros pacientes.
 * - **PostgREST con el JWT del paciente** para reservar y para listar los turnos
 *   propios. Son datos propios y la autoridad es RLS: aunque este service tuviera
 *   un bug, la base no deja insertar un turno a nombre de otro
 *   (`appointments_insert_own_patient`) ni leer los de un tercero
 *   (`appointments_select_own`).
 */

/** Solo los profesionales con la matrícula validada son públicos y reservables.
 *  Mismo filtro que el catálogo de ENG-49; es el único que no puede venir del
 *  cliente. */
const BOOKABLE_STATUS = 'VALIDADO';

/**
 * Hasta cuántos días adelante se puede ver y reservar, contando hoy.
 *
 * Es un límite de negocio, no técnico: sin él, un paciente podría reservar un
 * turno para dentro de dos años sobre una agenda que el profesional va a cambiar
 * cincuenta veces antes.
 *
 * Eran 28 —las 4 semanas del criterio de aceptación original de ENG-54—, y se
 * ampliaron a dos meses. Con cuatro semanas, un paciente que quería un control
 * para "dentro de un mes y medio" simplemente no podía reservarlo: la pantalla
 * no se lo ofrecía y no había forma de pedirlo. Sesenta días cubren el caso sin
 * volver al problema de agendar sobre una agenda que todavía no existe.
 *
 * `mediconnect-web/src/features/appointments/lib/weeks.ts` tiene la misma
 * constante para paginar sin preguntar. Si cambia una, tiene que cambiar la otra.
 */
export const BOOKING_HORIZON_DAYS = 60;

/**
 * Tope de días que puede pedir una consulta de disponibilidad. Acota el trabajo
 * por request.
 *
 * Tiene que dar para el horizonte ENTERO: la pantalla de reserva pide todo de
 * una vez y pagina en el cliente, porque es la única forma de saber en qué
 * página está el primer día con lugar sin haberla pedido antes. Con un tope
 * menor que el horizonte, esa consulta sería un 400.
 */
const MAX_RANGE_DAYS = BOOKING_HORIZON_DAYS + 2;

/** Estados que ocupan el horario. Espeja el índice parcial
 *  `appointments_professional_active_slot_key` de la migración: si cambia uno,
 *  tiene que cambiar el otro o la base y la app dejan de coincidir. */
const ACTIVE_STATUSES = ['RESERVADO_SIN_PAGAR', 'CONFIRMADO'] as const;

/** `23505 unique_violation` de Postgres, que PostgREST propaga tal cual. */
const UNIQUE_VIOLATION = '23505';

/** `P2025` de Prisma: el `where` del update no encontró ninguna fila. */
const PRISMA_RECORD_NOT_FOUND = 'P2025';
/** El índice único de la base rechazó el UPDATE: el horario lo tomó otro turno. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** Datos del profesional que ve el paciente en la pantalla de reserva. */
export interface BookableProfessional {
  id: string;
  firstName: string;
  lastName: string;
  /** `null` si todavía no publicó su precio: en ese caso no se puede reservar. */
  consultationPrice: number | null;
  currency: string;
}

export interface AvailabilityView {
  professional: BookableProfessional;
  from: string;
  to: string;
  days: AvailabilityDay[];
}

/** Persona referenciada por un turno, con lo mínimo para mostrarla. */
export interface AppointmentParty {
  id: string;
  firstName: string;
  lastName: string;
}

export interface AppointmentView {
  id: string;
  /** Instante ISO-8601 en UTC, tal como está en la base. */
  scheduledAt: string;
  /** Fecha y hora **locales** (Argentina): son las que el paciente eligió. */
  date: string;
  startTime: string;
  durationMinutes: number;
  price: number;
  currency: string;
  status: string;
  professional: AppointmentParty | null;
  patient: AppointmentParty | null;
  /** Cuándo se movió de horario (ENG-66), o `null` si nunca. Se reprograma una sola vez. */
  rescheduledAt: string | null;
}

/** Fila cruda de `appointments` tal como la devuelve PostgREST. */
interface AppointmentRow {
  id: string;
  patient_id: string;
  professional_id: string;
  scheduled_at: string;
  duration_minutes: number;
  // PostgREST devuelve `numeric` como string; se normaliza a number al salir.
  price: string | number;
  status: string;
  rescheduled_at?: string | null;
}

const APPOINTMENT_SELECT =
  'id, patient_id, professional_id, scheduled_at, duration_minutes, price, status, rescheduled_at';

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly payments: AppointmentPaymentService,
    private readonly unpaidRelease: UnpaidReleaseService,
    private readonly inApp: InAppNotificationsService,
    private readonly policies: CancellationPolicyService,
  ) {}

  /**
   * Grilla de horarios del profesional entre `from` y `to` (inclusive), con cada
   * horario marcado como disponible, ocupado, bloqueado o pasado.
   */
  async getAvailability(
    professionalId: string,
    query: AvailabilityQueryDto,
    now: Date = new Date(),
  ): Promise<AvailabilityView> {
    const { from, to } = this.assertValidRange(query, now);

    const professional = await this.findBookableProfessional(professionalId);
    const { rules, blocks, busy } = await this.readSchedule(
      professionalId,
      from,
      to,
      now,
    );

    return {
      professional,
      from,
      to,
      days: buildAvailability({ rules, blocks, busy, from, to, now }),
    };
  }

  /**
   * Reserva un turno en estado `RESERVADO_SIN_PAGAR`.
   *
   * El estado inicial no es un detalle: el turno **no** queda confirmado al
   * reservarlo. La confirmación llega con el pago (ENG-63/ENG-64) y hasta
   * entonces el turno es una retención, que vence a los 15 minutos sin pago
   * (ENG-101, `UnpaidReleaseService`).
   */
  async book(
    accessToken: string,
    userId: string,
    dto: CreateAppointmentDto,
    now: Date = new Date(),
  ): Promise<AppointmentView> {
    assertWithinHorizon(dto.date, now);

    const professional = await this.findBookableProfessional(
      dto.professionalId,
    );

    // `appointments.price` es NOT NULL y el precio se congela en el turno (si el
    // profesional lo sube mañana, el turno ya reservado no cambia). Sin precio
    // publicado no hay nada que congelar.
    if (professional.consultationPrice === null) {
      throw new ConflictException(
        'El profesional todavía no publicó su precio de consulta, así que no se puede reservar.',
      );
    }

    // Las retenciones vencidas que el job todavía no liberó ya no cuentan como
    // ocupadas en la disponibilidad, pero el índice único de la base sí las ve:
    // sin esto, reservar ese horario daría 409. Se acota al profesional (el
    // horario pedido) y al paciente (`assertPatientIsFree`).
    await this.unpaidRelease.releaseExpired(now, {
      professionalId: dto.professionalId,
      patientId: userId,
    });

    const slot = await this.assertSlotBookable(
      dto.professionalId,
      dto.date,
      dto.startTime,
      now,
    );

    const scheduledAt = toInstant(dto.date, dto.startTime);
    const client = this.supabase.getClientForToken(accessToken);

    await this.assertPatientProfileExists(client, userId);
    await this.assertPatientIsFree(
      client,
      userId,
      scheduledAt,
      slot.durationMinutes,
    );

    const { data, error } = await client
      .from('appointments')
      .insert({
        patient_id: userId,
        professional_id: dto.professionalId,
        scheduled_at: scheduledAt.toISOString(),
        duration_minutes: slot.durationMinutes,
        price: professional.consultationPrice,
        // `status` no se manda: lo pone el DEFAULT de la columna
        // (RESERVADO_SIN_PAGAR). Mandarlo desde acá sería el primer paso para que
        // algún día se acepte del cliente.
      })
      .select(APPOINTMENT_SELECT)
      .single();

    if (error) {
      // La carrera real: dos pacientes confirman el mismo horario a la vez y los
      // dos pasan la validación de arriba, porque miran un estado que ya cambió
      // cuando el INSERT llega. El árbitro es el índice parcial de la base.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException(
          'Ese turno lo acaba de reservar otra persona. Elegí otro horario.',
        );
      }
      throw new InternalServerErrorException(
        'No pudimos reservar el turno. Probá de nuevo en unos minutos.',
      );
    }

    const [view] = await this.toViews([data as unknown as AppointmentRow]);
    return view;
  }

  /**
   * Turnos del usuario autenticado, del más próximo al más lejano.
   *
   * Sirve para los dos roles: RLS (`appointments_select_own`) devuelve los turnos
   * donde el usuario es el paciente **o** el profesional, así que el mismo
   * endpoint alimenta la lista del paciente y la del profesional. La pantalla
   * completa de "Mis turnos" es ENG-55; acá se expone el dato.
   */
  async listMine(
    accessToken: string,
    userId: string,
  ): Promise<AppointmentView[]> {
    const client = this.supabase.getClientForToken(accessToken);

    const { data, error } = await client
      .from('appointments')
      .select(APPOINTMENT_SELECT)
      .or(`patient_id.eq.${userId},professional_id.eq.${userId}`)
      .order('scheduled_at', { ascending: true });

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos cargar tus turnos. Probá de nuevo en unos minutos.',
      );
    }

    return this.toViews((data ?? []) as unknown as AppointmentRow[]);
  }

  /**
   * Cancela un turno futuro del paciente (ENG-55).
   *
   * **Sin reembolso.** Devolver la plata de un turno ya pago es ENG-65, con la
   * política de `cancellation_policies`, encima de este mismo camino. Lo que sí
   * se hace acá es vencer el link de pago (ENG-63): si no, la pestaña de
   * MercadoPago que el paciente dejó abierta cobraría un turno cancelado. Es
   * best-effort —si MercadoPago no contesta, el link vence solo a los 15 minutos
   * como mucho— y no hace fallar la cancelación.
   *
   * Se lee por PostgREST y se escribe por Prisma, y la asimetría es a propósito:
   *
   * - La **lectura** es la autorización. `appointments_select_own` decide si el
   *   usuario participa del turno; si no, no hay fila y la respuesta es 404 sin
   *   que este service tenga que confiar en su propia comparación de ids.
   * - La **escritura** va por el owner porque la migración de ENG-54 no concede
   *   UPDATE a `authenticated`, y no conviene concederlo: una policy no puede
   *   limitar QUÉ columna se toca, así que el mismo UPDATE que permite cancelar
   *   dejaría al paciente moverse el `scheduled_at`, bajarse el `price` o
   *   ponerse el turno en CONFIRMADO sin haber pagado. La transición acotada
   *   vive acá.
   *
   * Las tres condiciones se revalidan en el `where` del update y no solo en los
   * `if` de arriba: entre la lectura y la escritura el turno puede haber
   * cambiado (el profesional lo completó, el job de ENG-101 lo liberó, un
   * segundo click ya lo canceló). Si el `where` no matchea, Prisma tira P2025 y
   * sale como 409 en vez de pisar un estado que ya no era el que se validó.
   */
  async cancel(
    accessToken: string,
    userId: string,
    appointmentId: string,
    now: Date = new Date(),
  ): Promise<AppointmentView> {
    const client = this.supabase.getClientForToken(accessToken);

    const { data, error } = await client
      .from('appointments')
      .select(APPOINTMENT_SELECT)
      .eq('id', appointmentId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos cancelar el turno. Probá de nuevo en unos minutos.',
      );
    }
    // También cae acá el turno de otra persona: RLS no lo devuelve, así que para
    // este usuario no existe. Un 403 confirmaría que el id es real.
    if (!data) {
      throw new NotFoundException('Ese turno no existe.');
    }

    const row = data as unknown as AppointmentRow;

    // El profesional SÍ ve el turno (la policy de select cubre los dos roles),
    // pero el criterio de aceptación dice "el paciente puede cancelar". Que el
    // profesional cancele es otra historia, con otro aviso al paciente.
    if (row.patient_id !== userId) {
      throw new ForbiddenException(
        'Solo el paciente puede cancelar el turno desde acá.',
      );
    }

    if (new Date(row.scheduled_at) <= now) {
      throw new BadRequestException('Ese turno ya pasó: no se puede cancelar.');
    }

    if (
      !ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number])
    ) {
      throw new ConflictException('Ese turno ya no está activo.');
    }

    try {
      const updated = await this.prisma.appointment.update({
        where: {
          id: appointmentId,
          patient_id: userId,
          status: { in: [...ACTIVE_STATUSES] },
          scheduled_at: { gt: now },
        },
        data: {
          status: 'CANCELADO',
          cancelled_at: now,
          // La columna tiene DEFAULT now() pero no `@updatedAt`: Prisma no la
          // toca sola y quedaría con la fecha de la reserva.
          updated_at: now,
        },
      });

      const [view] = await this.toViews([
        {
          id: updated.id,
          patient_id: updated.patient_id,
          professional_id: updated.professional_id,
          scheduled_at: updated.scheduled_at.toISOString(),
          duration_minutes: updated.duration_minutes,
          // `Decimal` no es `string | number`; `toString()` conserva los
          // decimales que un `Number` intermedio podría redondear.
          price: updated.price.toString(),
          status: updated.status,
          rescheduled_at: updated.rescheduled_at?.toISOString() ?? null,
        },
      ]);
      // Después del update, no antes: si la cancelación falla, el link tiene
      // que seguir sirviendo. `expireCheckout` nunca tira.
      await this.payments.expireCheckout(appointmentId, now);
      // El horario quedó libre: el profesional se entera por la campanita
      // (ENG-69). Solo si el turno estaba confirmado: de una reserva sin pagar
      // nunca se le avisó, y "te cancelaron" sería de un turno que no conoce.
      // Nunca tira.
      if (row.status === 'CONFIRMADO') {
        await this.inApp.notifyProfessional(
          appointmentId,
          'TURNO_CANCELADO',
          now,
        );
      }
      return view;
    } catch (err) {
      if ((err as { code?: string }).code === PRISMA_RECORD_NOT_FOUND) {
        throw new ConflictException(
          'El turno cambió de estado mientras lo cancelabas. Actualizá la lista.',
        );
      }
      throw new InternalServerErrorException(
        'No pudimos cancelar el turno. Probá de nuevo en unos minutos.',
      );
    }
  }

  /**
   * Mueve un turno futuro propio a otro horario del mismo profesional (ENG-66).
   *
   * Es el **mismo turno**: se actualiza la fila, así que el pago, la preferencia
   * de MercadoPago y el precio congelado siguen atados a él y no se vuelve a
   * cobrar.
   *
   * Reglas, además de las de una reserva nueva (agenda, bloqueos, 15 minutos de
   * anticipación, que el paciente no tenga otro turno superpuesto):
   *
   * - **Una sola vez por turno** (`rescheduled_at`). Sin tope, una reserva sin
   *   pagar se podría ir corriendo para retener horarios, y el profesional
   *   recibiría un aviso por cada vuelta.
   * - **Un turno pagado respeta la política de cancelación:** solo se reprograma
   *   mientras al paciente le correspondería la devolución total. Con menos
   *   anticipación, reprogramar sería cancelar sin la penalidad que la política
   *   aplica, así que se le dice que cancele (con el porcentaje que le toque) y
   *   reserve de nuevo.
   * - **Una reserva sin pagar** se puede mover mientras su retención de 15
   *   minutos no venció, y la retención **no se reinicia**: cuenta desde que se
   *   reservó.
   *
   * La política es la vigente del profesional. Cuando entre ENG-65 (backend#78),
   * que la congela en el turno al reservar, hay que leer esa.
   */
  async reschedule(
    accessToken: string,
    userId: string,
    appointmentId: string,
    dto: RescheduleAppointmentDto,
    now: Date = new Date(),
  ): Promise<AppointmentView> {
    const client = this.supabase.getClientForToken(accessToken);

    const { data, error } = await client
      .from('appointments')
      .select(`${APPOINTMENT_SELECT}, created_at`)
      .eq('id', appointmentId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos reprogramar el turno. Probá de nuevo en unos minutos.',
      );
    }
    // Igual que al cancelar: el turno de otra persona no existe para este usuario.
    if (!data) {
      throw new NotFoundException('Ese turno no existe.');
    }

    const row = data as unknown as AppointmentRow & { created_at: string };

    if (row.patient_id !== userId) {
      throw new ForbiddenException(
        'Solo el paciente puede reprogramar el turno desde acá.',
      );
    }

    const currentStart = new Date(row.scheduled_at);
    if (currentStart <= now) {
      throw new BadRequestException(
        'Ese turno ya pasó: no se puede reprogramar.',
      );
    }

    if (
      !ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number])
    ) {
      throw new ConflictException('Ese turno ya no está activo.');
    }

    if (row.rescheduled_at) {
      throw new ConflictException(
        'Este turno ya se reprogramó una vez. Si necesitás otro horario, cancelalo y reservá uno nuevo.',
      );
    }

    if (row.status === 'CONFIRMADO') {
      const policy = await this.policies.policyFor(row.professional_id);
      const percent = refundPercentFor(policy, currentStart, now);
      if (percent < 100) {
        const devolucion =
          percent === 0
            ? 'no te corresponde devolución'
            : `te corresponde el ${percent} % de devolución`;
        throw new ConflictException(
          `Un turno pagado se puede reprogramar hasta ${policy.hoursFullRefund} horas antes. ` +
            `Si necesitás otro horario, cancelalo (${devolucion}) y reservá uno nuevo.`,
        );
      }
    } else if (holdExpiresAt(new Date(row.created_at)) <= now) {
      throw new ConflictException(
        'La reserva venció porque no se pagó a tiempo. Volvé a reservar el turno.',
      );
    }

    assertWithinHorizon(dto.date, now);

    const newStart = toInstant(dto.date, dto.startTime);
    if (newStart.getTime() === currentStart.getTime()) {
      throw new BadRequestException('Ese ya es el horario de tu turno.');
    }

    await this.unpaidRelease.releaseExpired(now, {
      professionalId: row.professional_id,
      patientId: userId,
    });

    const slot = await this.assertSlotBookable(
      row.professional_id,
      dto.date,
      dto.startTime,
      now,
    );

    await this.assertPatientIsFree(
      client,
      userId,
      newStart,
      slot.durationMinutes,
      appointmentId,
    );

    let updated;
    try {
      updated = await this.prisma.appointment.update({
        // Las mismas condiciones que se validaron, revalidadas en el `where`:
        // entre la lectura y la escritura el turno pudo cambiar (lo cancelaron,
        // el job lo liberó, otro click ya lo reprogramó). El estado se revalida
        // exacto, no "cualquier activo": si el webhook de MercadoPago lo pasó a
        // CONFIRMADO en el medio, se salteó la regla de devolución y el aviso al
        // profesional, y tiene que volver a evaluarse (P2025 -> 409).
        where: {
          id: appointmentId,
          patient_id: userId,
          status: row.status as (typeof ACTIVE_STATUSES)[number],
          scheduled_at: currentStart,
          rescheduled_at: null,
        },
        data: {
          scheduled_at: newStart,
          duration_minutes: slot.durationMinutes,
          rescheduled_at: now,
          updated_at: now,
        },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      // La carrera con otra reserva del mismo horario: el árbitro es el índice
      // parcial `appointments_professional_active_slot_key`, como al reservar.
      if (code === PRISMA_UNIQUE_VIOLATION) {
        throw new ConflictException(
          'Ese horario lo acaba de reservar otra persona. Elegí otro.',
        );
      }
      if (code === PRISMA_RECORD_NOT_FOUND) {
        throw new ConflictException(
          'El turno cambió mientras lo reprogramabas. Actualizá la lista.',
        );
      }
      throw new InternalServerErrorException(
        'No pudimos reprogramar el turno. Probá de nuevo en unos minutos.',
      );
    }

    // Solo de un turno confirmado: de una reserva sin pagar el profesional
    // todavía no se enteró. Nunca tira. Va apenas después del `update`, antes de
    // armar la vista: si `toViews` fallara, el turno ya se movió y el aviso no
    // se puede perder.
    if (row.status === 'CONFIRMADO') {
      await this.inApp.notifyProfessional(
        appointmentId,
        'TURNO_REPROGRAMADO',
        now,
        { previousScheduledAt: currentStart.toISOString() },
      );
    }

    const [view] = await this.toViews([
      {
        id: updated.id,
        patient_id: updated.patient_id,
        professional_id: updated.professional_id,
        scheduled_at: updated.scheduled_at.toISOString(),
        duration_minutes: updated.duration_minutes,
        price: updated.price.toString(),
        status: updated.status,
        rescheduled_at: updated.rescheduled_at?.toISOString() ?? null,
      },
    ]);
    return view;
  }

  /**
   * Que el horario exista en la agenda del profesional y esté libre, contra la
   * agenda recalculada en el servidor y no contra lo que diga el cliente: el
   * front puede tener la grilla vieja o manipulada. Lo comparten la reserva y
   * la reprogramación.
   */
  private async assertSlotBookable(
    professionalId: string,
    date: string,
    startTime: string,
    now: Date,
  ) {
    const { rules, blocks, busy } = await this.readSchedule(
      professionalId,
      date,
      date,
      now,
    );
    const days = buildAvailability({
      rules,
      blocks,
      busy,
      from: date,
      to: date,
      now,
    });
    const slot = findSlot(days, date, startTime);

    if (!slot) {
      throw new BadRequestException(
        'Ese horario no está en la agenda del profesional.',
      );
    }
    if (slot.status === 'BOOKED') {
      throw new ConflictException('Ese turno ya está reservado.');
    }
    if (slot.status === 'BLOCKED') {
      throw new ConflictException(
        'El profesional no atiende en ese horario ese día.',
      );
    }
    if (slot.status === 'PAST') {
      throw new BadRequestException(
        'Ese horario ya pasó o empieza en menos de 15 minutos.',
      );
    }

    return slot;
  }

  /** Valida el rango pedido: coherente, acotado y dentro del horizonte. */
  private assertValidRange(
    { from, to }: AvailabilityQueryDto,
    now: Date,
  ): { from: string; to: string } {
    if (to < from) {
      throw new BadRequestException(
        'La fecha "hasta" no puede ser anterior a la fecha "desde".',
      );
    }

    if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `No se pueden pedir más de ${MAX_RANGE_DAYS} días de disponibilidad por consulta.`,
      );
    }

    const horizon = addDays(todayInArgentina(now), BOOKING_HORIZON_DAYS - 1);
    if (to > horizon) {
      throw new BadRequestException(
        `La agenda se publica hasta ${horizon} (${BOOKING_HORIZON_DAYS} días).`,
      );
    }

    // `from` en el pasado NO se rechaza: la pantalla pide semanas completas de
    // lunes a domingo, y la semana en curso empieza antes que hoy. Los horarios
    // ya transcurridos vuelven marcados como `PAST`, que es información útil, y
    // reservarlos lo impide `book`.
    return { from, to };
  }

  /** Perfil público del profesional, o 404 si no existe o no está validado. */
  private async findBookableProfessional(
    professionalId: string,
  ): Promise<BookableProfessional> {
    const row = await this.prisma.professional.findFirst({
      where: { profile_id: professionalId, status: BOOKABLE_STATUS },
      select: {
        profile_id: true,
        first_name: true,
        last_name: true,
        consultation_price: true,
        currency: true,
      },
    });

    if (!row) {
      // Mismo 404 para "no existe" y para "no está validado": si fueran mensajes
      // distintos, cualquiera podría averiguar qué profesionales están pendientes
      // de validación probando UUIDs.
      throw new NotFoundException('No encontramos a ese profesional.');
    }

    return {
      id: row.profile_id,
      firstName: row.first_name,
      lastName: row.last_name,
      // Prisma devuelve Decimal: sin el cast, el JSON sale como `{ s, e, d }`.
      consultationPrice:
        row.consultation_price === null ? null : Number(row.consultation_price),
      currency: row.currency,
    };
  }

  /** Franjas, bloqueos y turnos tomados del profesional en el rango pedido. */
  private async readSchedule(
    professionalId: string,
    from: string,
    to: string,
    now: Date,
  ): Promise<{
    rules: AvailabilityRule[];
    blocks: AvailabilityBlock[];
    busy: BusySlot[];
  }> {
    // El rango de instantes cubre desde el arranque del primer día hasta el
    // arranque del día siguiente al último, en hora local: un turno de las 23:30
    // del último día tiene que entrar.
    const rangeStart = toInstant(from, '00:00');
    const rangeEnd = toInstant(addDays(to, 1), '00:00');

    const [ruleRows, blockRows, busyRows] = await Promise.all([
      this.prisma.scheduleRule.findMany({
        where: { professional_id: professionalId },
        select: {
          weekday: true,
          start_time: true,
          end_time: true,
          slot_duration_minutes: true,
        },
      }),
      this.prisma.scheduleBlock.findMany({
        where: {
          professional_id: professionalId,
          block_date: {
            gte: new Date(`${from}T00:00:00Z`),
            lte: new Date(`${to}T00:00:00Z`),
          },
        },
        select: { block_date: true, start_time: true, end_time: true },
      }),
      this.prisma.appointment.findMany({
        where: {
          professional_id: professionalId,
          scheduled_at: { gte: rangeStart, lt: rangeEnd },
          // Una retención vencida (ENG-101) deja de ocupar el horario aunque el
          // job todavía no la haya pasado a LIBERADO.
          OR: [
            { status: 'CONFIRMADO' },
            {
              status: 'RESERVADO_SIN_PAGAR',
              created_at: { gt: new Date(now.getTime() - UNPAID_HOLD_MS) },
            },
          ],
        },
        select: { scheduled_at: true, duration_minutes: true },
      }),
    ]);

    return {
      rules: ruleRows.map((row) => ({
        weekday: row.weekday,
        startTime: toHHMM(row.start_time),
        endTime: toHHMM(row.end_time),
        slotDurationMinutes: row.slot_duration_minutes,
      })),
      blocks: blockRows.map((row) => ({
        blockDate: row.block_date.toISOString().slice(0, 10),
        startTime: row.start_time === null ? null : toHHMM(row.start_time),
        endTime: row.end_time === null ? null : toHHMM(row.end_time),
      })),
      busy: busyRows.map((row) => ({
        scheduledAt: row.scheduled_at,
        durationMinutes: row.duration_minutes,
      })),
    };
  }

  /**
   * La fila de `patients` no existe hasta que el paciente completa su perfil
   * (ENG-47), y `appointments.patient_id` es FK contra ella. Sin este chequeo, el
   * INSERT fallaría con un `23503` crudo y el paciente vería "no pudimos reservar"
   * sin enterarse de que le falta un paso.
   */
  private async assertPatientProfileExists(
    client: ReturnType<SupabaseService['getClientForToken']>,
    userId: string,
  ): Promise<void> {
    const { data, error } = await client
      .from('patients')
      .select('profile_id')
      .eq('profile_id', userId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos reservar el turno. Probá de nuevo en unos minutos.',
      );
    }
    if (!data) {
      throw new ConflictException(
        'Completá tu perfil de paciente antes de reservar un turno.',
      );
    }
  }

  /**
   * El paciente no puede estar en dos consultas a la vez, aunque sean con
   * profesionales distintos.
   *
   * Esto NO lo puede cubrir la unique de la base, que es por profesional. Queda
   * una ventana de carrera mínima (dos reservas simultáneas del mismo paciente en
   * horarios que se pisan): resolverla necesitaría un constraint EXCLUDE con
   * `btree_gist` sobre un rango, y el escenario —una persona haciendo dos reservas
   * en paralelo contra sí misma— no justifica esa complejidad hoy. Queda anotado.
   */
  private async assertPatientIsFree(
    client: ReturnType<SupabaseService['getClientForToken']>,
    userId: string,
    scheduledAt: Date,
    durationMinutes: number,
    /** Al reprogramar, el propio turno no cuenta como superpuesto. */
    excludeAppointmentId?: string,
  ): Promise<void> {
    const newEnd = new Date(scheduledAt.getTime() + durationMinutes * 60_000);

    // Se traen los turnos del día alrededor del horario pedido y el solape se
    // evalúa en memoria: PostgREST no expresa "start < X and start + duration > Y"
    // porque la duración es otra columna, no una constante.
    const windowStart = new Date(scheduledAt.getTime() - 24 * 60 * 60_000);
    const { data, error } = await client
      .from('appointments')
      .select('id, scheduled_at, duration_minutes')
      .eq('patient_id', userId)
      .in('status', [...ACTIVE_STATUSES])
      .gte('scheduled_at', windowStart.toISOString())
      .lt('scheduled_at', newEnd.toISOString());

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos reservar el turno. Probá de nuevo en unos minutos.',
      );
    }

    const rows = (
      (data ?? []) as unknown as {
        id: string;
        scheduled_at: string;
        duration_minutes: number;
      }[]
    ).filter(
      (row) =>
        excludeAppointmentId === undefined || row.id !== excludeAppointmentId,
    );

    const collides = rows.some((row) => {
      const start = new Date(row.scheduled_at).getTime();
      const end = start + row.duration_minutes * 60_000;
      return start < newEnd.getTime() && scheduledAt.getTime() < end;
    });

    if (collides) {
      throw new ConflictException(
        'Ya tenés otro turno reservado que se superpone con ese horario.',
      );
    }
  }

  /**
   * Completa las filas con los nombres de las personas involucradas.
   *
   * Los nombres salen por Prisma y no por PostgREST a propósito: RLS solo deja a
   * cada uno leer su propia fila de `professionals` / `patients`, así que un
   * embed de PostgREST devolvería `null`. La autorización ya la hizo RLS al
   * decidir QUÉ turnos ve el usuario; esto solo resuelve los nombres de los ids
   * que esa decisión dejó pasar, y nunca lee una persona que no aparezca en un
   * turno del propio usuario.
   */
  private async toViews(rows: AppointmentRow[]): Promise<AppointmentView[]> {
    if (rows.length === 0) return [];

    const professionalIds = [
      ...new Set(rows.map((row) => row.professional_id)),
    ];
    const patientIds = [...new Set(rows.map((row) => row.patient_id))];

    const [professionals, patients] = await Promise.all([
      this.prisma.professional.findMany({
        where: { profile_id: { in: professionalIds } },
        select: {
          profile_id: true,
          first_name: true,
          last_name: true,
          currency: true,
        },
      }),
      this.prisma.patient.findMany({
        where: { profile_id: { in: patientIds } },
        select: { profile_id: true, first_name: true, last_name: true },
      }),
    ]);

    const byId = (
      people: { profile_id: string; first_name: string; last_name: string }[],
    ) =>
      new Map(
        people.map((person) => [
          person.profile_id,
          {
            id: person.profile_id,
            firstName: person.first_name,
            lastName: person.last_name,
          },
        ]),
      );

    const professionalById = byId(professionals);
    const patientById = byId(patients);

    // `appointments` no tiene columna de moneda: el precio se congela en el turno
    // y la moneda sale del profesional que lo cobra. Se expone igual para que el
    // front no tenga que asumir "ARS" al formatear.
    const currencyById = new Map(
      professionals.map((pro) => [pro.profile_id, pro.currency]),
    );

    return rows.map((row) => {
      const scheduledAt = new Date(row.scheduled_at);
      const { date, startTime } = toLocalDateTime(scheduledAt);

      return {
        id: row.id,
        scheduledAt: scheduledAt.toISOString(),
        date,
        startTime,
        durationMinutes: row.duration_minutes,
        price: Number(row.price),
        currency: currencyById.get(row.professional_id) ?? 'ARS',
        status: row.status,
        professional: professionalById.get(row.professional_id) ?? null,
        patient: patientById.get(row.patient_id) ?? null,
        rescheduledAt: row.rescheduled_at
          ? new Date(row.rescheduled_at).toISOString()
          : null,
      };
    });
  }
}

/**
 * Prisma mapea las columnas `time` de Postgres a `Date` con la fecha en la época
 * (1970-01-01) y la hora en UTC. Recortar el ISO es la forma directa de volver a
 * `HH:MM`; convertirlo con `getHours()` aplicaría el huso del servidor y correría
 * las 09:00 del profesional a las 06:00.
 */
function toHHMM(time: Date): string {
  return time.toISOString().slice(11, 16);
}

/** La fecha pedida tiene que estar entre hoy y el horizonte publicado de la agenda. */
function assertWithinHorizon(date: string, now: Date): void {
  const today = todayInArgentina(now);
  const horizon = addDays(today, BOOKING_HORIZON_DAYS - 1);

  if (date < today || date > horizon) {
    throw new BadRequestException(
      `Solo se pueden reservar turnos dentro de los próximos ${BOOKING_HORIZON_DAYS} días.`,
    );
  }
}
