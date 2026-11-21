import { IsInt, Max, Min } from 'class-validator';
import {
  MAX_FULL_REFUND_HOURS,
  MAX_REFUND_PERCENT,
  MIN_PARTIAL_REFUND_PERCENT,
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
  // Límite de plataforma (ENG-205): el 100 % aplica al menos desde 24 h antes.
  @Max(MAX_FULL_REFUND_HOURS, {
    message: `El reembolso total tiene que aplicar al menos desde ${MAX_FULL_REFUND_HOURS} horas antes del turno`,
  })
  hoursFullRefund!: number;

  /** Horas de antelación a partir de las cuales se devuelve el parcial. */
  @IsInt({
    message: 'Las horas para el reembolso parcial deben ser un número entero',
  })
  @Min(0, {
    message: 'Las horas para el reembolso parcial no pueden ser negativas',
  })
  // No puede estar más lejos que el total, que tiene tope de 24 h.
  @Max(MAX_FULL_REFUND_HOURS, {
    message: `Las horas para el reembolso parcial no pueden superar ${MAX_FULL_REFUND_HOURS}`,
  })
  hoursPartialRefund!: number;

  /**
   * Porcentaje que se devuelve en la ventana intermedia.
   *
   * Límite de plataforma (ENG-205): al menos el 30 %. `100` se admite: equivale
   * a estirar la ventana del total.
   */
  @IsInt({ message: 'El porcentaje debe ser un número entero' })
  @Min(MIN_PARTIAL_REFUND_PERCENT, {
    message: `La devolución parcial tiene que ser de al menos el ${MIN_PARTIAL_REFUND_PERCENT} %`,
  })
  @Max(MAX_REFUND_PERCENT, {
    message: `El porcentaje no puede superar ${MAX_REFUND_PERCENT}`,
  })
  partialRefundPercent!: number;
}
