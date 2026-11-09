import type { Prisma } from '../../generated/prisma/client';

/**
 * Cuándo un turno se puede reseñar (ENG-80, ampliado en ENG-190).
 *
 * - **Completado**: lo cerró el profesional o el job (ENG-189).
 * - **Confirmado y el paciente entró a la sala**: así puede calificar apenas
 *   sale, aunque el profesional todavía no haya tocado "Finalizar". Que haya
 *   entrado ya implica que la sala abrió.
 *
 * Un paciente que nunca entró no reseña, y `NO_ASISTIO` no habilita: no hubo
 * consulta que opinar.
 */
export function isReviewable(
  status: string,
  patientJoinedAt: Date | null | undefined,
): boolean {
  return (
    status === 'COMPLETADO' || (status === 'CONFIRMADO' && !!patientJoinedAt)
  );
}

/** La misma regla como filtro de Prisma, para listar sin traer de más. */
export const REVIEWABLE_WHERE: Prisma.AppointmentWhereInput = {
  OR: [
    { status: 'COMPLETADO' },
    {
      status: 'CONFIRMADO',
      consultation: { patient_joined_at: { not: null } },
    },
  ],
};
