import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

/** Largo mínimo del motivo: "no puedo" no le explica nada al paciente. */
export const MIN_CANCELLATION_REASON_LENGTH = 10;
/** Largo máximo del motivo: entra en un aviso y en un mail. */
export const MAX_CANCELLATION_REASON_LENGTH = 500;

/**
 * Cuerpo de `PATCH /appointments/:id/cancel-by-professional` (ENG-204).
 *
 * El motivo es obligatorio (ADR-018, caso 1): el paciente lo ve en el aviso y
 * queda en el turno. Se recortan los espacios antes de validar el largo, así un
 * motivo de puros espacios no pasa.
 */
export class CancelByProfessionalDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'El motivo tiene que ser texto.' })
  @Length(MIN_CANCELLATION_REASON_LENGTH, MAX_CANCELLATION_REASON_LENGTH, {
    message: `El motivo tiene que tener entre ${MIN_CANCELLATION_REASON_LENGTH} y ${MAX_CANCELLATION_REASON_LENGTH} caracteres.`,
  })
  reason!: string;
}
