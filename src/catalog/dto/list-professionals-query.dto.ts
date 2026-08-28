import { Type } from 'class-transformer';
import {
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

  @IsOptional()
  @IsUUID('4', { message: 'specialtyId debe ser un UUID válido' })
  specialtyId?: string;

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
