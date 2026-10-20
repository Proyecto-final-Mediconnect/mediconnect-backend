/**
 * Cuánto retiene el horario un turno reservado y no pagado (ENG-101).
 *
 * Se cuenta desde la **reserva** (`appointments.created_at`), no desde que se
 * pide el link de pago: si se contara desde el link, pedir uno nuevo cada 14
 * minutos retendría el horario para siempre sin pagar nunca.
 *
 * Lo usan los dos lados del mismo plazo, y por eso vive en un solo lugar:
 * - `UnpaidReleaseService`, que pasa el turno a `LIBERADO` cuando vence.
 * - `AppointmentPaymentService`, que no deja que el link de pago viva más que
 *   la retención. Si el link sobreviviera, el paciente pagaría un turno que el
 *   job ya liberó y esa plata habría que devolverla a mano.
 */
export const UNPAID_HOLD_MS = 15 * 60 * 1000;

/**
 * Anticipación mínima para reservar: igual a la retención.
 *
 * El job no libera turnos que ya empezaron (ver `UnpaidReleaseService`). Si se
 * pudiera reservar a las 9:55 el turno de las 10:00, la retención vencería a
 * las 10:10, con el turno ya empezado: nunca se liberaría y, como la
 * videoconsulta admite `RESERVADO_SIN_PAGAR`, el paciente se atendería sin
 * pagar. Exigiendo esta anticipación, toda retención vence antes de que empiece
 * su turno.
 */
export const MIN_BOOKING_LEAD_MS = UNPAID_HOLD_MS;

/** Instante en que vence la retención de un turno reservado en `createdAt`. */
export function holdExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + UNPAID_HOLD_MS);
}
