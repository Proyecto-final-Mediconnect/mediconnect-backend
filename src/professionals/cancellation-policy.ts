/**
 * Política de cancelación del profesional (ENG-67, HU-26).
 *
 * Cuánto se le devuelve al paciente según con cuánta antelación cancele. Son dos
 * ventanas y tres resultados:
 *
 * ```
 *   ... mucha antelación ...  |  ... menos ...  |  ... poca ...  [TURNO]
 *            100 %            |  partialPercent |       0 %
 *                   hoursFullRefund      hoursPartialRefund
 * ```
 *
 * Este archivo es **puro**: no toca Nest, ni Prisma, ni la red. El motivo es el
 * mismo que en `hash-chain.ts`: la regla de negocio se puede testear sin base y
 * la consume quien la necesite. Y acá hay un consumidor concreto esperando —
 * **ENG-65 (reembolsos)**, que necesita saber cuánto devolver antes de pedirle
 * nada a MercadoPago. Es la razón por la que esta historia va antes de esa.
 */

/** Los tres valores de una política, ya resueltos (sin `null`). */
export interface CancellationPolicy {
  /** Horas de antelación a partir de las cuales se devuelve el 100 %. */
  hoursFullRefund: number;
  /** Horas de antelación a partir de las cuales se devuelve `partialRefundPercent`. */
  hoursPartialRefund: number;
  /** Porcentaje de la ventana intermedia, 0 a 100. */
  partialRefundPercent: number;
}

/**
 * La política que aplica a un profesional que no configuró la suya.
 *
 * **24 h → 100 %, 6 h → 50 %, menos de 6 h → 0 %.**
 *
 * No son valores inventados: son los que `prisma/seed-demo.ts` ya escribe para
 * los profesionales de la demo, así que el default formaliza lo que el proyecto
 * venía mostrando en lugar de introducir una tercera versión de la regla.
 *
 * Que exista un default y no un "sin política" es una decisión de producto: un
 * turno pago sin política declarada deja al paciente sin saber a qué atenerse y
 * al equipo sin criterio para resolver el primer reclamo. Es preferible un
 * default conservador y visible.
 */
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  hoursFullRefund: 24,
  hoursPartialRefund: 6,
  partialRefundPercent: 50,
};

/**
 * Tope de horas de antelación configurables: 720 h, 30 días.
 *
 * Sin tope, `smallint` deja poner 8760 (un año) y el profesional queda con una
 * política que **nunca** devuelve nada mientras muestra que "tiene política".
 * Treinta días es más que cualquier antelación con la que se reserva un turno
 * médico en la plataforma, así que no limita ningún caso legítimo.
 *
 * Es un supuesto: el ticket llegó sin refinar y el número no está acordado con
 * el equipo. Queda anotado en el ticket para confirmarlo.
 */
export const MAX_POLICY_HOURS = 720;

/** El porcentaje es un porcentaje. */
export const MIN_REFUND_PERCENT = 0;
export const MAX_REFUND_PERCENT = 100;

/**
 * Fila de `cancellation_policies` tal como puede venir de la base: las tres
 * columnas son `nullable` en el esquema.
 */
export interface CancellationPolicyRow {
  hours_full_refund: number | null;
  hours_partial_refund: number | null;
  partial_refund_percent: number | null;
}

/**
 * Resuelve la fila de la base a una política evaluable, cayendo al default.
 *
 * **Una fila con cualquiera de los tres campos en `null` se trata como no
 * configurada**, y no como una política parcial a completar con el default. Es
 * la única lectura en la que el comportamiento es total: mezclar un
 * `hoursFullRefund` propio con un `partialRefundPercent` del default produce
 * combinaciones que el profesional nunca eligió —y que pueden incluso violar el
 * invariante de que la ventana total esté más lejos que la parcial—.
 *
 * `null` como fila entera (el profesional no tiene fila) es el caso normal, no
 * un error: la fila nace en el primer `PUT`, igual que `patients` nace en la
 * primera carga del perfil (ENG-47).
 */
export function resolvePolicy(row: CancellationPolicyRow | null | undefined): {
  policy: CancellationPolicy;
  configured: boolean;
} {
  if (
    !row ||
    row.hours_full_refund === null ||
    row.hours_partial_refund === null ||
    row.partial_refund_percent === null
  ) {
    return { policy: DEFAULT_CANCELLATION_POLICY, configured: false };
  }

  return {
    policy: {
      hoursFullRefund: row.hours_full_refund,
      hoursPartialRefund: row.hours_partial_refund,
      partialRefundPercent: row.partial_refund_percent,
    },
    configured: true,
  };
}

/**
 * Qué porcentaje del turno le corresponde al paciente si cancela ahora.
 *
 * **Es el contrato con ENG-65.** Devuelve un entero de 0 a 100; el monto lo
 * calcula quien reembolsa, sobre `appointments.price`, que es el precio
 * congelado al reservar (ENG-54).
 *
 * ## El límite exacto favorece al paciente
 *
 * Las comparaciones son `>=`, así que cancelar **exactamente** 24 h antes
 * devuelve el 100 % y no el 50 %. Es deliberado: en el borde hay que elegir, y
 * la alternativa es discutir segundos con alguien que miró el reloj y canceló a
 * tiempo. El sesgo va para el lado del que no controla el sistema.
 *
 * ## Un turno pasado devuelve 0
 *
 * No es un caso especial: `hoursUntil` queda negativo y cae en el último tramo.
 * Se deja dicho porque es el estado en el que un turno `NO_ASISTIO` llega acá, y
 * la respuesta correcta es que no se devuelve nada.
 */
export function refundPercentFor(
  policy: CancellationPolicy,
  scheduledAt: Date,
  now: Date,
): number {
  const hoursUntil = (scheduledAt.getTime() - now.getTime()) / 3_600_000;

  if (hoursUntil >= policy.hoursFullRefund) return MAX_REFUND_PERCENT;
  if (hoursUntil >= policy.hoursPartialRefund)
    return policy.partialRefundPercent;

  return MIN_REFUND_PERCENT;
}

/**
 * Por qué una política no es válida, o `null` si lo es.
 *
 * Devuelve el mensaje y no un booleano porque es el texto que ve el profesional:
 * "la política no es válida" no le dice qué corregir.
 *
 * La validación de rangos la hace el DTO con `class-validator`; esto cubre lo
 * que un decorador por campo no puede ver, que es **la relación entre los dos
 * plazos**.
 */
export function validatePolicy(policy: CancellationPolicy): string | null {
  if (policy.hoursFullRefund < policy.hoursPartialRefund) {
    return (
      'La ventana de reembolso total tiene que estar más lejos del turno que la parcial: ' +
      `con ${policy.hoursFullRefund} h para el total y ${policy.hoursPartialRefund} h para el parcial, ` +
      'el parcial nunca se aplicaría.'
    );
  }

  return null;
}
