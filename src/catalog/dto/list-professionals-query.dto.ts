import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

/** Tamaño de página del catálogo público (ENG-49: 20 por página). */
export const DEFAULT_PAGE_SIZE = 20;
/** Techo del `limit` para que un cliente no pueda pedir la tabla entera. */
export const MAX_PAGE_SIZE = 50;
/**
 * Techo de especialidades por consulta. El catálogo es curado y chico (17 al
 * escribir esto, crece por PR), así que 50 deja margen para tildarlas todas y
 * acota el `IN` que se le manda a Postgres: sin tope, un cliente puede pedir
 * miles de UUIDs en una sola query.
 */
export const MAX_SPECIALTY_FILTERS = 50;

@ValidatorConstraint({ name: 'maxPriceNotBelowMin' })
class MaxPriceNotBelowMinConstraint implements ValidatorConstraintInterface {
  validate(maxPrice: unknown, args: ValidationArguments): boolean {
    const { minPrice } = args.object as ListProfessionalsQueryDto;
    if (typeof maxPrice !== 'number' || typeof minPrice !== 'number') {
      return true;
    }
    return maxPrice >= minPrice;
  }

  defaultMessage(): string {
    return 'maxPrice debe ser mayor o igual que minPrice';
  }
}

/**
 * Filtros del catálogo público. Los query params llegan siempre como string,
 * de ahí los `@Type`/`@Transform`: sin ellos `@IsInt` rechazaría `"2"`.
 */
export class ListProfessionalsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un entero' })
  @Min(1, { message: 'page debe ser mayor o igual que 1' })
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser un entero' })
  @Min(1, { message: 'limit debe ser mayor o igual que 1' })
  @Max(MAX_PAGE_SIZE, { message: `limit no puede superar ${MAX_PAGE_SIZE}` })
  limit: number = DEFAULT_PAGE_SIZE;

  /**
   * Especialidades por las que filtrar. El parámetro se repite —
   * `?specialtyId=a&specialtyId=b`— y se acumulan en OR: entran los
   * profesionales que tengan **alguna** de las elegidas.
   *
   * OR y no AND porque el filtro es una lista de opciones marcadas, no un
   * refinamiento sucesivo: tildar "Cardiología" y "Pediatría" significa "cualquiera
   * de las dos", que es lo que hace todo catálogo con checkboxes. Con AND, sumar
   * una segunda especialidad casi siempre daría cero resultados — muy pocos
   * profesionales tienen más de una.
   *
   * Se conserva el nombre en singular a propósito: Express ya entrega un array
   * cuando el parámetro viene repetido, es la convención habitual (`?tag=a&tag=b`)
   * y así ninguna URL guardada de la versión de un solo valor deja de funcionar.
   */
  @IsOptional()
  // Con un solo valor Express entrega un string, con varios un array. El
  // `Transform` normaliza a array ANTES de validar para que el resto del DTO y
  // el service vean siempre lo mismo, y descarta repetidos: `?specialtyId=a&specialtyId=a`
  // no tiene por qué llegar dos veces al `IN`.
  @Transform(({ value }): unknown => {
    if (value === undefined) return undefined;
    const list = Array.isArray(value) ? value : [value];
    return [...new Set(list)];
  })
  @IsArray({ message: 'specialtyId debe ser un UUID o una lista de UUIDs' })
  @ArrayMaxSize(MAX_SPECIALTY_FILTERS, {
    message: `no se pueden filtrar más de ${MAX_SPECIALTY_FILTERS} especialidades a la vez`,
  })
  @IsUUID('4', { each: true, message: 'specialtyId debe ser un UUID válido' })
  specialtyId?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'minPrice debe ser numérico' })
  @Min(0, { message: 'minPrice no puede ser negativo' })
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'maxPrice debe ser numérico' })
  @Min(0, { message: 'maxPrice no puede ser negativo' })
  @Validate(MaxPriceNotBelowMinConstraint)
  maxPrice?: number;
}
