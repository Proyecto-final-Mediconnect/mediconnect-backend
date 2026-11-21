/**
 * Las tareas periódicas del backend y cada cuánto corren (ENG-228).
 *
 * Es la fuente única de los nombres: los usan el controller (la ruta), el
 * registro en `job_runs`, el estado de `/internal/jobs/status` y el script de
 * `pg_cron` (`scripts/scheduler/pg-cron.sql`). **Si agregás un job o cambiás
 * su frecuencia, actualizá también ese script**, que es el que de verdad lo
 * dispara.
 */
export const JOBS = {
  /** ENG-101: la retención de un turno sin pagar es de 15 minutos. */
  'release-unpaid-appointments': { everyMinutes: 1 },
  /** ENG-68: la ventana del recordatorio de 1 h es (ahora, ahora + 1 h]. */
  'send-appointment-reminders': { everyMinutes: 5 },
  /** ENG-104: los accesos al MediPass duran 30 minutos. */
  'close-expired-medipass-sessions': { everyMinutes: 1 },
  /** ENG-189: cierra los turnos cuya sala ya cerró. */
  'close-finished-appointments': { everyMinutes: 5 },
  /** ENG-190: el pedido de reseña sale 3 h después del cierre. */
  'send-review-requests': { everyMinutes: 5 },
  /** ENG-204 (ADR-018, caso 2): vence el plazo de un turno a reprogramar. */
  'resolve-reprogram-deadlines': { everyMinutes: 5 },
  /** ENG-205 (ADR-018, caso 16): retoma los reembolsos que quedaron pendientes. */
  'retry-pending-refunds': { everyMinutes: 15 },
} as const satisfies Record<string, { everyMinutes: number }>;

export type JobName = keyof typeof JOBS;

export const JOB_NAMES = Object.keys(JOBS) as JobName[];

/**
 * Cuánto puede durar una corrida antes de darla por muerta. Si el proceso se
 * cae a mitad de un job, su fila queda `RUNNING` y bloquearía el job para
 * siempre: pasado este tope, la próxima corrida la cierra como `ERROR` y sigue.
 * Ningún job tarda más de unos segundos.
 */
export const JOB_MAX_RUNTIME_MINUTES = 10;

/**
 * Cuándo un job se considera atrasado en `/internal/jobs/status`: sin una
 * corrida `OK` en tres intervalos seguidos, con un mínimo de 15 minutos para
 * no alarmar por un reinicio del servicio.
 */
export function staleAfterMinutes(job: JobName): number {
  return Math.max(JOBS[job].everyMinutes * 3, 15);
}

/**
 * Monitor de Sentry Crons que vigila al scheduler entero (ENG-228).
 *
 * Los errores de cada job ya llegan a Sentry como excepciones. Lo que no llega
 * es el silencio: si `pg_cron` deja de disparar o Render no responde, nadie
 * falla, simplemente no pasa nada. Este monitor espera un check-in cada 5
 * minutos y Sentry alerta si no llega. Va atado a los recordatorios porque es el
 * job de 5 minutos más importante para el paciente.
 */
export const SCHEDULER_MONITOR = {
  slug: 'mediconnect-scheduler',
  job: 'send-appointment-reminders' as JobName,
  config: {
    schedule: { type: 'crontab', value: '*/5 * * * *' },
    checkinMargin: 5,
    maxRuntime: JOB_MAX_RUNTIME_MINUTES,
    timezone: 'UTC',
  },
} as const;
