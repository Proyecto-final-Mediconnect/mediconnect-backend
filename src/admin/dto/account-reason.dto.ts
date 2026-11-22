import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

/** Largo del motivo de una suspensión o reactivación: el profesional lo lee. */
export const MIN_ACCOUNT_REASON_LENGTH = 10;
export const MAX_ACCOUNT_REASON_LENGTH = 500;

/**
 * Cuerpo de `PATCH /admin/professionals/:id/suspension` y `/reactivation`
 * (ENG-241). El motivo es obligatorio: queda en la auditoría y, al suspender,
 * le llega al profesional por mail. Se recortan los espacios antes de validar.
 */
export class AccountReasonDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'El motivo tiene que ser texto.' })
  @Length(MIN_ACCOUNT_REASON_LENGTH, MAX_ACCOUNT_REASON_LENGTH, {
    message: `El motivo tiene que tener entre ${MIN_ACCOUNT_REASON_LENGTH} y ${MAX_ACCOUNT_REASON_LENGTH} caracteres.`,
  })
  reason!: string;
}
