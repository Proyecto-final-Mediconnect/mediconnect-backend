import { Transform } from 'class-transformer';
import { IsIn, IsString, Length, ValidateIf } from 'class-validator';

export const LICENSE_DECISIONS = ['VALIDADO', 'RECHAZADO'] as const;
export type LicenseDecision = (typeof LICENSE_DECISIONS)[number];

/** Largo mínimo del motivo de un rechazo: "no" no le explica nada al profesional. */
export const MIN_LICENSE_REASON_LENGTH = 10;
/** Largo máximo: entra en el mail y en la auditoría. */
export const MAX_LICENSE_REASON_LENGTH = 500;

/**
 * Cuerpo de `PATCH /admin/professionals/:id/license` (ENG-192).
 *
 * El motivo es obligatorio al rechazar: el profesional lo recibe por mail y
 * queda en la auditoría. Al validar es opcional. Se recortan los espacios antes
 * de validar el largo, así un motivo de puros espacios no pasa.
 */
export class DecideLicenseDto {
  @IsIn(LICENSE_DECISIONS, {
    message: 'La decisión tiene que ser VALIDADO o RECHAZADO.',
  })
  decision!: LicenseDecision;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf(
    (dto: DecideLicenseDto) =>
      dto.decision === 'RECHAZADO' || dto.reason !== undefined,
  )
  @IsString({ message: 'El motivo tiene que ser texto.' })
  @Length(MIN_LICENSE_REASON_LENGTH, MAX_LICENSE_REASON_LENGTH, {
    message: `El motivo tiene que tener entre ${MIN_LICENSE_REASON_LENGTH} y ${MAX_LICENSE_REASON_LENGTH} caracteres.`,
  })
  reason?: string;
}
