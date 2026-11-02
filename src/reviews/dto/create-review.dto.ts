import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Una reseña sobre la consulta de un turno (ENG-80). */
export class CreateReviewDto {
  @IsInt({ message: 'La calificación tiene que ser un número entero.' })
  @Min(1, { message: 'La calificación va de 1 a 5.' })
  @Max(5, { message: 'La calificación va de 1 a 5.' })
  rating!: number;

  /** Opcional: hay quien solo quiere poner las estrellas. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(1000, {
    message: 'El comentario no puede pasar los 1000 caracteres.',
  })
  comment?: string;
}
