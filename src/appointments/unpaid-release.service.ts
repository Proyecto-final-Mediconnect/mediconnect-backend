import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AppointmentPaymentService } from '../payments/appointment-payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { UNPAID_HOLD_MS } from './unpaid-hold';

/** Acota la liberación a los turnos de un profesional o de un paciente. */
export interface ReleaseScope {
  professionalId?: string;
  patientId?: string;
}

/**
 * Libera los turnos reservados que no se pagaron a tiempo (ENG-101).
 *
 * Un turno nace `RESERVADO_SIN_PAGAR` y ocupa el horario. Si en
 * {@link UNPAID_HOLD_MS} no se paga, pasa a `LIBERADO` y el horario vuelve a
 * estar disponible.
 *
 * ## Quién lo llama
 *
 * - **El job** (`POST /internal/jobs/release-unpaid-appointments`), que dispara
 *   un workflow de GitHub Actions cada 5 minutos. El plan gratis de Render se
 *   duerme, así que un cron dentro del proceso no correría.
 * - **`book()`**, acotado al profesional y al paciente de la reserva. El job
 *   puede llegar hasta ~5 minutos tarde (más si GitHub demora el cron). En ese
 *   rato la disponibilidad ya no muestra la retención vencida, pero el índice
 *   único de la base sí la ve. Sin esta llamada, reservar ese horario daría
 *   409 aunque la pantalla lo ofrezca libre.
 *
 * ## Qué turnos libera, y cuáles no
 *
 * - Solo los que **todavía no empezaron**. Lo que esta historia libera es
 *   disponibilidad, y un horario que ya pasó no tiene nada que liberar. Además,
 *   antes de ENG-63 todo turno quedaba `RESERVADO_SIN_PAGAR` para siempre y la
 *   videoconsulta los admite: hay consultas que ocurrieron en ese estado.
 *   Pasarlas a `LIBERADO` le cortaría al profesional el acceso a la HC de un
 *   paciente que sí atendió (`READABLE_APPOINTMENT_STATUSES`).
 * - Nunca uno con un pago `APROBADO`. Si el webhook está a mitad de confirmar,
 *   el turno es del paciente que pagó.
 *
 * ## Por qué un UPDATE crudo
 *
 * Hacen falta los ids de lo que se liberó para vencer cada link de pago, y
 * `updateMany` solo devuelve la cantidad. Un `findMany` seguido de un
 * `updateMany` dejaría una ventana en la que el webhook confirma un turno que
 * igual entra en la lista. `UPDATE … RETURNING` decide y devuelve en un solo
 * paso. Los valores van parametrizados por el tagged template de Prisma.
 */
@Injectable()
export class UnpaidReleaseService {
  private readonly logger = new Logger(UnpaidReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: AppointmentPaymentService,
  ) {}

  /** Libera las retenciones vencidas y devuelve los ids de los turnos liberados. */
  async releaseExpired(
    now: Date = new Date(),
    scope: ReleaseScope = {},
  ): Promise<string[]> {
    const cutoff = new Date(now.getTime() - UNPAID_HOLD_MS);

    const released = await this.prisma.$queryRaw<{ id: string }[]>`
      update public.appointments a
         set status = 'LIBERADO'::appointment_status,
             updated_at = ${now}
       where a.status = 'RESERVADO_SIN_PAGAR'::appointment_status
         and a.created_at <= ${cutoff}
         and a.scheduled_at > ${now}
         ${scopeFilter(scope)}
         and not exists (
           select 1
             from public.payments p
            where p.appointment_id = a.id
              and p.status = 'APROBADO'::payment_status
         )
      returning a.id`;

    const ids = released.map((row) => row.id);

    // Después del UPDATE, igual que en la cancelación: el link ya no debería
    // estar vivo (vence con la retención), pero si quedó uno abierto se vence
    // acá. `expireCheckout` nunca tira, así que un error de MercadoPago no deja
    // a medias el resto de la tanda.
    for (const id of ids) {
      await this.payments.expireCheckout(id, now);
    }

    if (ids.length > 0) {
      this.logger.log(`Turnos liberados por falta de pago: ${ids.length}.`);
    }

    return ids;
  }
}

/** `and (...)` con los filtros del scope, o nada si viene vacío. */
function scopeFilter({ professionalId, patientId }: ReleaseScope): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (professionalId) {
    conditions.push(Prisma.sql`a.professional_id = ${professionalId}::uuid`);
  }
  if (patientId) {
    conditions.push(Prisma.sql`a.patient_id = ${patientId}::uuid`);
  }

  return conditions.length === 0
    ? Prisma.empty
    : Prisma.sql`and (${Prisma.join(conditions, ' or ')})`;
}
