import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** La decisión del moderador sobre una reseña pendiente (ENG-81). */
export class ModerateReviewDto {
  @IsIn(['APROBADA', 'RECHAZADA'], {
    message: 'La decisión tiene que ser APROBADA o RECHAZADA.',
  })
  decision!: 'APROBADA' | 'RECHAZADA';

  /**
   * Obligatorio al rechazar: el paciente recibe el motivo, y "rechazada" sin
   * explicación no le dice qué cambiar. Al aprobar es opcional.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @ValidateIf(
    (dto: ModerateReviewDto) =>
      dto.decision === 'RECHAZADA' || dto.reason !== undefined,
  )
  @IsString()
  @IsNotEmpty({ message: 'Para rechazar una reseña hay que decir por qué.' })
  @MaxLength(500, { message: 'El motivo no puede pasar los 500 caracteres.' })
  reason?: string;
}
