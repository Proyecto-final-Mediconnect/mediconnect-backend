/**
 * Fila de `appointments` que leen el cierre del turno (ENG-189) y la
 * videoconsulta (ENG-56). Un solo lugar para que las dos lecturas no diverjan.
 */
export interface AppointmentRow {
  id: string;
  patient_id: string;
  professional_id: string;
  scheduled_at: string;
  duration_minutes: number;
  status: string;
  created_at: string;
}

export const APPOINTMENT_SELECT =
  'id, patient_id, professional_id, scheduled_at, duration_minutes, status, created_at';
