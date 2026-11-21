import type { Prisma } from '../../generated/prisma/client';

/**
 * Deja la consulta de un turno como si nadie hubiera entrado (ENG-237).
 *
 * `consultations` y `video_sessions` son 1:1 con el turno. Cuando un turno pasa
 * a `A_REPROGRAMAR` y el paciente elige otro horario, sigue siendo el mismo
 * turno: si quedaran las entradas y la sala de la consulta que no se hizo, el
 * cierre automático (`closeFinished`) daría por hecha la consulta nueva, se
 * podría reseñar antes de tiempo y la sala vieja, ya vencida, se reusaría.
 *
 * Se borran solo las marcas de asistencia y la sala. Las notas, el resumen y la
 * historia clínica de la consulta se conservan. Quién había entrado queda en
 * `audit_logs`, en la transición que llama a esto.
 */
export async function resetAttendance(
  tx: Prisma.TransactionClient,
  appointmentIds: string[],
): Promise<void> {
  if (appointmentIds.length === 0) return;
  await tx.consultation.updateMany({
    where: { appointment_id: { in: appointmentIds } },
    data: {
      patient_joined_at: null,
      professional_joined_at: null,
      ended_at: null,
    },
  });
  await tx.videoSession.updateMany({
    where: { consultation: { appointment_id: { in: appointmentIds } } },
    data: {
      daily_room_name: null,
      daily_room_url: null,
      daily_room_expires_at: null,
      status: 'CREADA',
      ended_at: null,
    },
  });
}
