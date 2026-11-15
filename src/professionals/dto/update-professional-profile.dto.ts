import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Recorta un texto; lo que no es string pasa para que lo rechace el validador. */
const recortar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

/** Cuántos títulos se aceptan. Es un perfil público, no un CV completo. */
export const MAX_EDUCATION = 10;

/** El año más viejo que se acepta para un título. */
export const MIN_EDUCATION_YEAR = 1950;

/** Un título del profesional: dónde, qué y, si quiere, en qué año (ENG-48). */
export class EducationItemDto {
  @Transform(recortar)
  @IsString()
  @MinLength(2, { message: 'Cada título tiene que decir la institución' })
  @MaxLength(150, { message: 'El nombre de la institución es demasiado largo' })
  institution!: string;

  @Transform(recortar)
  @IsString()
  @MinLength(2, { message: 'Cada título tiene que decir qué estudiaste' })
  @MaxLength(150, { message: 'El nombre del título es demasiado largo' })
  degree!: string;

  /** El tope (el año actual) lo valida el service: acá sería fijo al arrancar. */
  @IsOptional()
  @IsInt({ message: 'El año tiene que ser un número entero' })
  @Min(MIN_EDUCATION_YEAR, {
    message: `El año no puede ser anterior a ${MIN_EDUCATION_YEAR}`,
  })
  year?: number | null;
}

/** Actualización parcial del perfil público del profesional (ENG-48). Todos
 *  los campos son opcionales: el profesional puede completar el perfil por
 *  partes. La foto se sube por su propio endpoint (POST /professionals/me/photo). */
export class UpdateProfessionalProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'La bio no puede superar los 500 caracteres' })
  bio?: string;

  /**
   * Precio de la consulta en pesos argentinos.
   *
   * Tres estados distintos, y la diferencia importa: **omitirlo** es "no lo
   * toques", mandarlo con un número lo fija, y mandarlo en **`null`** borra el
   * precio publicado (el profesional deja de mostrar precio). `@IsOptional()`
   * ignora los validadores tanto con `undefined` como con `null`, así que el null
   * pasa la validación y llega al service, que lo escribe.
   */
  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El precio debe ser un número con hasta 2 decimales' },
  )
  @Min(0, { message: 'El precio no puede ser negativo' })
  @Max(99_999_999, { message: 'El precio supera el máximo permitido' })
  consultationPrice?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: 'Se pueden elegir hasta 3 especialidades' })
  @ArrayUnique({ message: 'No repitas especialidades' })
  @IsUUID('4', {
    each: true,
    message: 'Cada especialidad debe ser un identificador válido',
  })
  specialtyIds?: string[];

  /**
   * La formación que se muestra en el perfil público. Igual que las
   * especialidades, es un **reemplazo completo**: omitirla no la toca, y una
   * lista vacía la borra.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EDUCATION, {
    message: `Se pueden cargar hasta ${MAX_EDUCATION} títulos`,
  })
  @ValidateNested({ each: true })
  @Type(() => EducationItemDto)
  education?: EducationItemDto[];
}
