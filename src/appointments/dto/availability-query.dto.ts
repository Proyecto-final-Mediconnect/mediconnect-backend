import { Matches } from 'class-validator';

/** `YYYY-MM-DD`. Patrón explícito y no `@IsDateString()`, que acepta timestamps
 *  completos con zona: acá la fecha es una etiqueta de calendario, no un instante
 *  (mismo criterio que el DTO de bloqueos de ENG-53). */
export const YYYY_MM_DD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Rango de la grilla de disponibilidad. Los dos extremos son **inclusive**.
 *
 * El tope de días lo valida el service y no el DTO porque necesita comparar `from`
 * contra `to` y contra la fecha de hoy: `class-validator` puede exigir el formato
 * de cada campo por separado, pero no la relación entre ellos.
 */
export class AvailabilityQueryDto {
  @Matches(YYYY_MM_DD, {
    message: 'La fecha "desde" debe tener formato AAAA-MM-DD',
  })
  from!: string;

  @Matches(YYYY_MM_DD, {
    message: 'La fecha "hasta" debe tener formato AAAA-MM-DD',
  })
  to!: string;
}
