import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** El mismo tope que el comentario de una reseña. */
export const REVIEW_RESPONSE_MAX_LENGTH = 1000;

/** `PUT /reviews/:reviewId/response` (ENG-106): la respuesta pública del profesional. */
export class ReviewResponseDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'La respuesta tiene que ser texto.' })
  @IsNotEmpty({ message: 'La respuesta no puede estar vacía.' })
  @MaxLength(REVIEW_RESPONSE_MAX_LENGTH, {
    message: `La respuesta no puede pasar los ${REVIEW_RESPONSE_MAX_LENGTH} caracteres.`,
  })
  content!: string;
}
