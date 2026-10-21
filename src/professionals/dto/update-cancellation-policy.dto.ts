import { IsInt, Max, Min } from 'class-validator';
import {
  MAX_POLICY_HOURS,
  MAX_REFUND_PERCENT,
  MIN_REFUND_PERCENT,
} from '../cancellation-policy';

/**
 * Política de cancelación completa (ENG-67).
 *
 * **Los tres campos son obligatorios**, a diferencia del DTO del perfil
 * (`UpdateProfessionalProfileDto`), que es parcial a propósito. La razón es que
 * una política a medias no se puede evaluar: sin saber el porcentaje de la
 * ventana intermedia no hay forma de decidir cuánto devolver a un paciente que
 * cancela ahí. Por eso el verbo es `PUT` y no `PATCH`: se reemplaza entera.
 *
 * La relación entre los dos plazos —que el total esté más lejos que el parcial—
 * no se puede expresar con un decorador por campo y la valida `validatePolicy()`
 * en el service.
 */
export class UpdateCancellationPolicyDto {
  /** Horas de antelación a partir de las cuales se devuelve el 100 %. */
  @IsInt({
    message: 'Las horas para el reembolso total deben ser un número entero',
  })
  @Min(0, {
    message: 'Las horas para el reembolso total no pueden ser negativas',
  })
  @Max(MAX_POLICY_HOURS, {
    message: `Las horas para el reembolso total no pueden superar ${MAX_POLICY_HOURS} (30 días)`,
  })
  hoursFullRefund!: number;

  /** Horas de antelación a partir de las cuales se devuelve el parcial. */
  @IsInt({
    message: 'Las horas para el reembolso parcial deben ser un número entero',
  })
  @Min(0, {
    message: 'Las horas para el reembolso parcial no pueden ser negativas',
  })
  @Max(MAX_POLICY_HOURS, {
    message: `Las horas para el reembolso parcial no pueden superar ${MAX_POLICY_HOURS} (30 días)`,
  })
  hoursPartialRefund!: number;

  /**
   * Porcentaje que se devuelve en la ventana intermedia.
   *
   * Se admiten los extremos. `0` es una política válida —"o se devuelve todo o
   * nada"— y `100` también, que equivale a estirar la ventana del total. No se
   * rechazan porque son decisiones del profesional, no errores.
   */
  @IsInt({ message: 'El porcentaje debe ser un número entero' })
  @Min(MIN_REFUND_PERCENT, { message: 'El porcentaje no puede ser negativo' })
  @Max(MAX_REFUND_PERCENT, {
    message: `El porcentaje no puede superar ${MAX_REFUND_PERCENT}`,
  })
  partialRefundPercent!: number;
}
