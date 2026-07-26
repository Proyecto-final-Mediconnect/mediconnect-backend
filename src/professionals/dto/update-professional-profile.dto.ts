import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Actualización parcial del perfil público del profesional (ENG-48). Todos
 *  los campos son opcionales: el profesional puede completar el perfil por
 *  partes. La foto se sube por su propio endpoint (POST /professionals/me/photo). */
export class UpdateProfessionalProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'La bio no puede superar los 500 caracteres' })
  bio?: string;

  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El precio debe ser un número con hasta 2 decimales' },
  )
  @Min(0, { message: 'El precio no puede ser negativo' })
  @Max(99_999_999, { message: 'El precio supera el máximo permitido' })
  consultationPrice?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: 'Se pueden elegir hasta 3 especialidades' })
  @ArrayUnique({ message: 'No repitas especialidades' })
  @IsUUID('4', {
    each: true,
    message: 'Cada especialidad debe ser un identificador válido',
  })
  specialtyIds?: string[];
}
