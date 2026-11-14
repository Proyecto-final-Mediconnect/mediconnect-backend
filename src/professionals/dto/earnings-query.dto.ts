import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PeriodQueryDto } from '../../common/time/period.dto';
import type { EarningState, EarningsOrder } from '../earnings.service';

const ESTADOS: EarningState[] = [
  'COBRADO',
  'REEMBOLSO_PARCIAL',
  'REEMBOLSADO',
  'REEMBOLSO_PENDIENTE',
];
const ORDENES: EarningsOrder[] = ['RECIENTES', 'ANTIGUOS', 'MAYOR_MONTO'];

/** `?from&to&pagina&estado&paciente&orden` de "Mis cobros" (ENG-194). */
export class EarningsQueryDto extends PeriodQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pagina debe ser un entero' })
  @Min(1, { message: 'pagina debe ser mayor o igual que 1' })
  @Max(1000, { message: 'pagina no puede superar 1000' })
  pagina: number = 1;

  @IsOptional()
  @IsIn(ESTADOS, { message: 'estado no es válido' })
  estado?: EarningState;

  @IsOptional()
  @IsString({ message: 'paciente debe ser un texto' })
  @MaxLength(80, { message: 'paciente no puede superar 80 caracteres' })
  paciente?: string;

  @IsOptional()
  @IsIn(ORDENES, { message: 'orden no es válido' })
  orden?: EarningsOrder;
}
