import type { Prisma } from '../../generated/prisma/client';

/**
 * Cuándo un turno se puede reseñar (ENG-80, ampliado en ENG-190).
 *
 * - **Completado**: lo cerró el profesional o el job (ENG-189).
 * - **Confirmado, con la consulta en marcha**: entraron los dos a la sala y ya
 *   es la hora del turno. Así el paciente califica apenas sale, aunque el
 *   profesional todavía no haya tocado "Finalizar".
 *
 * Que solo haya entrado el paciente no alcanza: puede entrar 10 minutos antes y
 * opinar de una consulta que no ocurrió, y eso ensucia el promedio público
 * (ENG-82). Por eso hacen falta los dos y la hora (review de #114). Un
 * paciente que nunca entró no reseña, y `NO_ASISTIO` no habilita.
 */
export function isReviewable(
  appointment: {
    status: string;
    scheduled_at: Date;
    consultation?: {
      patient_joined_at: Date | null;
      professional_joined_at: Date | null;
    } | null;
  },
  now: Date,
): boolean {
  if (appointment.status === 'COMPLETADO') return true;
  return (
    appointment.status === 'CONFIRMADO' &&
    appointment.scheduled_at <= now &&
    !!appointment.consultation?.patient_joined_at &&
    !!appointment.consultation.professional_joined_at
  );
}

/** La misma regla como filtro de Prisma, para listar sin traer de más. */
export function reviewableWhere(now: Date): Prisma.AppointmentWhereInput {
  return {
    OR: [
      { status: 'COMPLETADO' },
      {
        status: 'CONFIRMADO',
        scheduled_at: { lte: now },
        consultation: {
          patient_joined_at: { not: null },
          professional_joined_at: { not: null },
        },
      },
    ],
  };
}
