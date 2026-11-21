import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { appointment_status } from '../../generated/prisma';
import { Prisma } from '../../generated/prisma/client';
import { APPOINTMENT_SELECT, type AppointmentRow } from './appointment-row';
import { resetAttendance } from './attendance-reset';
import { reprogramDeadlineAfterMissed } from './professional-cancellation.service';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { PatientNoticesService } from '../notifications/patient-notices.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { DailyService } from '../video/daily.service';
import {
  JOIN_GRACE_MINUTES_AFTER,
  isJoinableStatus,
  joinWindowFor,
} from '../video/consultation.config';

/**
 * Cierre del turno después de la consulta (ENG-189).
 *
 * Hasta acá ningún turno terminaba: `COMPLETADO` y `NO_ASISTIO` solo los ponía
 * la seed, así que un paciente real nunca podía reseñar (ENG-80 exige
 * `COMPLETADO`) y el turno quedaba `CONFIRMADO` para siempre.
 *
 * Cuatro caminos, todos auditados:
 *
 * - **El profesional finaliza** la consulta (`complete`).
 * - **El profesional marca que el paciente no se presentó** (`markNoShow`).
 * - **El job** cierra lo que nadie cerró, según quién entró a la sala
 *   (`closeFinished`). Si el profesional no entró, el turno no se hizo y queda
 *   a reprogramar (ENG-237, casos 3 y 4).
 * - **El profesional informa una falla técnica** de una consulta completada
 *   (`reportTechnicalFailure`, ENG-237, caso 13).
 */

/** Motivo que ve el paciente cuando el profesional no se conectó (casos 3 y 4). */
export const PROFESSIONAL_NO_SHOW_REASON =
  'El profesional no se conectó a la consulta.';

/** Cuánto después del final del turno el profesional todavía puede cerrarlo a
 *  mano. Pasado eso, el turno lo cerró el job o queda como está. */
export const MANUAL_CLOSE_HOURS_AFTER = 24;

export type ClosedStatus = 'COMPLETADO' | 'NO_ASISTIO';

export interface ClosedAppointment {
  id: string;
  /** `A_REPROGRAMAR`: no entró el profesional (ENG-237, casos 3 y 4). */
  status: ClosedStatus | 'A_REPROGRAMAR';
}

/** Resultado de informar una falla técnica (ENG-237, caso 13). */
export interface TechnicalFailureResult {
  id: string;
  status: 'A_REPROGRAMAR';
  /** ISO-8601: hasta cuándo el paciente elige otro horario o el reembolso. */
  reprogramDeadline: string;
}

const AUDIT_ACTION: Record<ClosedStatus, string> = {
  COMPLETADO: 'APPOINTMENT_COMPLETED',
  NO_ASISTIO: 'APPOINTMENT_NO_SHOW',
};

@Injectable()
export class AppointmentClosingService {
  private readonly logger = new Logger(AppointmentClosingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly daily: DailyService,
    private readonly notices: PatientNoticesService,
    private readonly inApp: InAppNotificationsService,
  ) {}

  /**
   * El profesional finaliza la consulta: el turno pasa a `COMPLETADO` y se
   * cierran la consulta y la sesión de video.
   *
   * Se puede desde que abre la sala hasta {@link MANUAL_CLOSE_HOURS_AFTER} horas
   * después del final, y **solo si entraron los dos** (`assertWhoJoined`): es
   * la misma regla que usa el job para decir que una consulta se hizo. Sin
   * esto, un turno al que nadie entró quedaba completado y habilitaba la
   * reseña. Si el paciente no entró, lo que corresponde es "no asistió".
   *
   * Idempotente: si el turno ya está completado devuelve lo mismo sin escribir
   * nada, porque "Finalizar" se puede tocar dos veces o reintentarse tras un
   * error de red.
   */
  async complete(
    accessToken: string,
    userId: string,
    appointmentId: string,
    now: Date = new Date(),
  ): Promise<ClosedAppointment> {
    const row = await this.readOwnAppointment(
      accessToken,
      userId,
      appointmentId,
    );
    if (row.status === 'COMPLETADO')
      return { id: row.id, status: 'COMPLETADO' };

    const { opensAt } = joinWindowFor(
      new Date(row.scheduled_at),
      row.duration_minutes,
    );
    this.assertManualWindow(
      row,
      opensAt,
      now,
      'La consulta todavía no empezó.',
    );
    await this.assertWhoJoined(row.id, 'COMPLETADO');

    await this.close(row, 'COMPLETADO', userId, now);
    await this.deleteRooms(row.id);
    return { id: row.id, status: 'COMPLETADO' };
  }

  /**
   * El profesional marca que el paciente no se presentó: el turno pasa a
   * `NO_ASISTIO`.
   *
   * Desde la hora del turno: antes no se puede saber que faltó. No reembolsa
   * nada; es lo mismo que `refundPercentFor` le da a un turno pasado
   * (`cancellation-policy.ts`). Idempotente como `complete`.
   *
   * Solo si el profesional entró a la sala y el paciente no
   * (`assertWhoJoined`), igual que el job. Sin esto el profesional podía
   * marcar ausente a un paciente que sí entró —que pierde el reembolso y la
   * reseña— o a uno al que él mismo dejó plantado.
   */
  async markNoShow(
    accessToken: string,
    userId: string,
    appointmentId: string,
    now: Date = new Date(),
  ): Promise<ClosedAppointment> {
    const row = await this.readOwnAppointment(
      accessToken,
      userId,
      appointmentId,
    );
    if (row.status === 'NO_ASISTIO')
      return { id: row.id, status: 'NO_ASISTIO' };

    this.assertManualWindow(
      row,
      new Date(row.scheduled_at),
      now,
      'Todavía no es la hora del turno.',
    );
    await this.assertWhoJoined(row.id, 'NO_ASISTIO');

    await this.close(row, 'NO_ASISTIO', userId, now);
    return { id: row.id, status: 'NO_ASISTIO' };
  }

  /**
   * Cierra los turnos `CONFIRMADO` cuya sala ya cerró, según quién entró:
   *
   * - Entraron los dos → `COMPLETADO`.
   * - Entró el profesional y el paciente no → `NO_ASISTIO`.
   * - El profesional no entró → **no se toca**. Es un turno pago al que el
   *   profesional faltó, y qué hacer con él (¿reembolso total?) es una decisión
   *   aparte que no puede tomar un job.
   *
   * Lo dispara `POST /internal/jobs/close-finished-appointments`. Es idempotente:
   * el `UPDATE` solo toma turnos todavía `CONFIRMADO`, así que una corrida
   * repetida no encuentra nada.
   *
   * Decide y escribe en un solo `UPDATE … RETURNING`, por lo mismo que la
   * liberación de impagos (ENG-101): un `findMany` seguido de un `update`
   * dejaría una ventana para que el profesional cierre a mano el mismo turno.
   */
  async closeFinished(now: Date = new Date()): Promise<ClosedAppointment[]> {
    const closed = await this.closeAttended(now);
    const missed = await this.resolveMissed(now);
    return [
      ...closed,
      ...missed.map((id) => ({ id, status: 'A_REPROGRAMAR' as const })),
    ];
  }

  /** Los turnos a los que entró el profesional: completados o no asistió. */
  private closeAttended(now: Date): Promise<ClosedAppointment[]> {
    return this.prisma.$transaction(async (tx) => {
      const closed = await tx.$queryRaw<{ id: string; status: ClosedStatus }[]>`
        update public.appointments a
           set status = (case when c.patient_joined_at is not null
                              then 'COMPLETADO' else 'NO_ASISTIO' end)::appointment_status,
               updated_at = ${now}
          from public.consultations c
         where c.appointment_id = a.id
           and a.status = 'CONFIRMADO'::appointment_status
           and c.professional_joined_at is not null
           and a.scheduled_at
               + make_interval(mins => a.duration_minutes + ${JOIN_GRACE_MINUTES_AFTER}::int)
               < ${now}
        returning a.id, a.status::text as status`;

      if (closed.length === 0) return [];

      const ids = closed.map((c) => c.id);
      await this.closeSession(tx, ids, now);
      await tx.auditLog.createMany({
        data: closed.map((c) => ({
          actor_id: null,
          action: AUDIT_ACTION[c.status],
          resource_type: 'appointments',
          resource_id: c.id,
          metadata: { previousStatus: 'CONFIRMADO', origin: 'JOB' },
        })),
      });

      this.logger.log(`Cerré ${closed.length} turno(s) vencido(s).`);
      return closed;
    });
  }

  /**
   * ENG-237 (ADR-018, casos 3 y 4): un turno `CONFIRMADO` cuya sala ya cerró y
   * al que **no entró el profesional** —haya entrado o no el paciente— no se
   * realizó. Pasa a `A_REPROGRAMAR` como si el profesional lo hubiera
   * cancelado: el paciente elige otro horario sin volver a pagar o el 100 %,
   * con 48 h desde el aviso.
   *
   * Decide y escribe en un solo `UPDATE … RETURNING`, como el cierre de arriba:
   * el `where` exige `CONFIRMADO`, así que una corrida repetida no lo toca dos
   * veces. Los avisos salen después del commit y nunca tiran.
   */
  private async resolveMissed(now: Date): Promise<string[]> {
    const deadline = reprogramDeadlineAfterMissed(now);
    const missed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; patient_joined: boolean }[]
      >`
        update public.appointments a
           set status = 'A_REPROGRAMAR'::appointment_status,
               cancelled_by = 'PROFESIONAL'::appointment_cancelled_by,
               reprogram_cause = 'AUSENCIA_PROFESIONAL'::appointment_reprogram_cause,
               cancellation_reason = ${PROFESSIONAL_NO_SHOW_REASON},
               cancelled_at = ${now},
               reprogram_deadline = ${deadline},
               updated_at = ${now}
          from public.appointments m
          left join public.consultations c on c.appointment_id = m.id
         where a.id = m.id
           and a.status = 'CONFIRMADO'::appointment_status
           and c.professional_joined_at is null
           and a.scheduled_at
               + make_interval(mins => a.duration_minutes + ${JOIN_GRACE_MINUTES_AFTER}::int)
               < ${now}
        returning a.id, (c.patient_joined_at is not null) as patient_joined`;
      if (rows.length === 0) return rows;

      await resetAttendance(
        tx,
        rows.map((r) => r.id),
      );
      await tx.auditLog.createMany({
        data: rows.map((r) => ({
          actor_id: null,
          action: 'APPOINTMENT_PROFESSIONAL_NO_SHOW',
          resource_type: 'appointments',
          resource_id: r.id,
          metadata: {
            previousStatus: 'CONFIRMADO',
            newStatus: 'A_REPROGRAMAR',
            patientJoined: r.patient_joined,
            reprogramDeadline: deadline.toISOString(),
            origin: 'JOB',
          },
        })),
      });
      return rows;
    });

    for (const { id } of missed) {
      await this.notices.professionalCancelled(id, 'A_REPROGRAMAR', now);
      await this.inApp.notifyProfessional(id, 'TURNO_NO_REALIZADO', now, {
        cause: 'AUSENCIA_PROFESIONAL',
      });
    }
    if (missed.length > 0) {
      this.logger.warn(
        `${missed.length} turno(s) sin el profesional: quedaron a reprogramar.`,
      );
    }
    return missed.map((r) => r.id);
  }

  /**
   * ENG-237 (ADR-018, caso 13): el profesional informa que una consulta
   * completada no se pudo hacer por una falla técnica. El turno pasa a
   * `A_REPROGRAMAR` como en el caso 1: el paciente elige otro horario sin
   * volver a pagar o el 100 %, con 48 h desde el aviso.
   *
   * Solo el profesional del turno, solo desde `COMPLETADO` y hasta
   * {@link MANUAL_CLOSE_HOURS_AFTER} horas después del final. El `where`
   * revalida estado y profesional: si algo cambió en el medio, 409.
   */
  async reportTechnicalFailure(
    accessToken: string,
    userId: string,
    appointmentId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<TechnicalFailureResult> {
    const row = await this.readOwnAppointment(
      accessToken,
      userId,
      appointmentId,
    );
    if (row.status !== 'COMPLETADO') {
      throw new ConflictException(
        'Solo se puede informar una falla técnica de una consulta completada.',
      );
    }
    const end =
      new Date(row.scheduled_at).getTime() + row.duration_minutes * 60_000;
    if (now.getTime() > end + MANUAL_CLOSE_HOURS_AFTER * 3_600_000) {
      throw new ConflictException(
        `Pasaron más de ${MANUAL_CLOSE_HOURS_AFTER} horas desde la consulta: ya no se puede informar una falla técnica.`,
      );
    }

    const deadline = reprogramDeadlineAfterMissed(now);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.appointment.update({
          where: {
            id: row.id,
            professional_id: userId,
            status: 'COMPLETADO',
          },
          data: {
            status: 'A_REPROGRAMAR',
            cancelled_by: 'PROFESIONAL',
            reprogram_cause: 'FALLA_TECNICA',
            cancellation_reason: reason,
            cancelled_at: now,
            reprogram_deadline: deadline,
            updated_at: now,
          },
        });
        await resetAttendance(tx, [row.id]);
        await tx.auditLog.create({
          data: {
            actor_id: userId,
            action: 'APPOINTMENT_TECHNICAL_FAILURE',
            resource_type: 'appointments',
            resource_id: row.id,
            metadata: {
              previousStatus: 'COMPLETADO',
              newStatus: 'A_REPROGRAMAR',
              reason,
              reprogramDeadline: deadline.toISOString(),
              origin: 'PROFESIONAL',
            },
          },
        });
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new ConflictException(
          'El turno cambió de estado mientras lo informabas. Actualizá la pantalla.',
        );
      }
      this.logger.error(
        `No se pudo informar la falla técnica del turno ${row.id}: ${String(err)}`,
      );
      throw new InternalServerErrorException(
        'No pudimos informar la falla técnica. Probá de nuevo en unos minutos.',
      );
    }

    await this.notices.professionalCancelled(row.id, 'A_REPROGRAMAR', now);
    return {
      id: row.id,
      status: 'A_REPROGRAMAR',
      reprogramDeadline: deadline.toISOString(),
    };
  }

  /**
   * Lee el turno con el JWT del usuario y exige que sea su profesional.
   *
   * RLS es la autorización de lectura: el turno de otras dos personas no
   * aparece y da 404, sin confirmar que el id existe. El paciente sí lo ve, y
   * a él le corresponde un 403: cerrar la consulta es del profesional.
   */
  private async readOwnAppointment(
    accessToken: string,
    userId: string,
    appointmentId: string,
  ): Promise<AppointmentRow> {
    const { data, error } = await this.supabase
      .getClientForToken(accessToken)
      .from('appointments')
      .select(APPOINTMENT_SELECT)
      .eq('id', appointmentId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos cerrar el turno. Probá de nuevo en unos minutos.',
      );
    }
    if (!data) throw new NotFoundException('Ese turno no existe.');

    const row = data as unknown as AppointmentRow;
    if (row.professional_id !== userId) {
      throw new ForbiddenException(
        'Solo el profesional del turno puede cerrarlo.',
      );
    }
    return row;
  }

  /**
   * Quién entró a la sala, con la misma regla que el job (`closeFinished`):
   *
   * - `COMPLETADO` exige que hayan entrado los dos.
   * - `NO_ASISTIO` exige que haya entrado el profesional y el paciente no.
   *
   * Sin fila de `consultations` no entró nadie: la crea el primero que entra.
   */
  private async assertWhoJoined(
    appointmentId: string,
    target: ClosedStatus,
  ): Promise<void> {
    const consultation = await this.prisma.consultation.findUnique({
      where: { appointment_id: appointmentId },
      select: { patient_joined_at: true, professional_joined_at: true },
    });
    const professional = !!consultation?.professional_joined_at;
    const patient = !!consultation?.patient_joined_at;

    if (!professional) {
      throw new ConflictException(
        target === 'COMPLETADO'
          ? 'Todavía no entraste a la sala de esta consulta.'
          : 'No entraste a la sala de este turno, así que no se puede marcar que el paciente no asistió.',
      );
    }
    if (target === 'COMPLETADO' && !patient) {
      throw new ConflictException(
        'El paciente no entró a la sala. Si no se presentó, marcalo como no asistió.',
      );
    }
    if (target === 'NO_ASISTIO' && patient) {
      throw new ConflictException(
        'El paciente entró a la sala, así que no se puede marcar como no asistió.',
      );
    }
  }

  /**
   * Borra la sala de Daily de un turno finalizado a mano: la sala sigue viva
   * hasta su `exp` y quien esté adentro sigue conectado, y Daily factura por
   * minuto de participante. Best-effort: si falla (o Daily no está configurado)
   * el cierre ya quedó escrito y la sala expira sola.
   */
  private async deleteRooms(appointmentId: string): Promise<void> {
    try {
      const sessions = await this.prisma.videoSession.findMany({
        where: {
          consultation: { appointment_id: appointmentId },
          daily_room_name: { not: null },
        },
        select: { daily_room_name: true },
      });
      await Promise.all(
        sessions.map((s) => this.daily.deleteRoom(s.daily_room_name as string)),
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo borrar la sala del turno ${appointmentId}: ${String(error)}`,
      );
    }
  }

  /** Estado que admite el cierre y ventana horaria de un cierre manual. */
  private assertManualWindow(
    row: AppointmentRow,
    from: Date,
    now: Date,
    tooEarlyMessage: string,
  ): void {
    // Los mismos estados que dejan entrar a la sala: solo el turno pago.
    if (!isJoinableStatus(row.status)) {
      throw new ConflictException('Ese turno ya no se puede cerrar.');
    }

    const end =
      new Date(row.scheduled_at).getTime() + row.duration_minutes * 60_000;
    const until = new Date(end + MANUAL_CLOSE_HOURS_AFTER * 3_600_000);

    if (now < from) throw new ConflictException(tooEarlyMessage);
    if (now > until) {
      throw new ConflictException(
        `Pasaron más de ${MANUAL_CLOSE_HOURS_AFTER} horas desde el turno: ya no se puede cerrar.`,
      );
    }
  }

  /**
   * Escribe el cierre manual. El `where` revalida estado y profesional: si
   * entre la lectura y la escritura el job o un segundo click ya lo cerró,
   * Prisma tira P2025 y sale como 409 en vez de pisar un estado que ya no era
   * el que se validó.
   */
  private async close(
    row: AppointmentRow,
    status: ClosedStatus,
    actorId: string,
    now: Date,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.appointment.update({
          where: {
            id: row.id,
            professional_id: actorId,
            status: row.status as appointment_status,
          },
          data: { status, updated_at: now },
        });
        if (status === 'COMPLETADO') await this.closeSession(tx, [row.id], now);
        await tx.auditLog.create({
          data: {
            actor_id: actorId,
            action: AUDIT_ACTION[status],
            resource_type: 'appointments',
            resource_id: row.id,
            metadata: { previousStatus: row.status, origin: 'PROFESIONAL' },
          },
        });
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new ConflictException(
          'El turno cambió de estado mientras lo cerrabas. Actualizá la pantalla.',
        );
      }
      this.logger.error(`No se pudo cerrar el turno ${row.id}: ${String(err)}`);
      throw new InternalServerErrorException(
        'No pudimos cerrar el turno. Probá de nuevo en unos minutos.',
      );
    }
  }

  /**
   * Cierra la consulta y su sesión de video. `ended_at` se escribe una sola vez
   * (`IS NULL`), así que el cierre no pisa uno anterior. Un turno sin consulta
   * (nadie entró a la sala) no tiene nada que cerrar acá.
   */
  private async closeSession(
    tx: Prisma.TransactionClient,
    appointmentIds: string[],
    now: Date,
  ): Promise<void> {
    await tx.consultation.updateMany({
      where: { appointment_id: { in: appointmentIds }, ended_at: null },
      data: { ended_at: now },
    });
    await tx.videoSession.updateMany({
      where: {
        consultation: { appointment_id: { in: appointmentIds } },
        status: { not: 'FINALIZADA' },
      },
      data: { status: 'FINALIZADA', ended_at: now },
    });
  }
}
