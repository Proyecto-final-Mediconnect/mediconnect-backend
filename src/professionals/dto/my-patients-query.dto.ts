import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** `?q&pagina` de "Mis pacientes" (ENG-197). */
export class MyPatientsQueryDto {
  @IsOptional()
  @IsString({ message: 'q debe ser un texto' })
  @MaxLength(80, { message: 'q no puede superar 80 caracteres' })
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pagina debe ser un entero' })
  @Min(1, { message: 'pagina debe ser mayor o igual que 1' })
  @Max(1000, { message: 'pagina no puede superar 1000' })
  pagina: number = 1;
}
