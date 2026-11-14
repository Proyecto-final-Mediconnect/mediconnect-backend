import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PeriodQueryDto } from '../../common/time/period.dto';

/** `?from&to&pagina` de "Mis cobros" (ENG-194). */
export class EarningsQueryDto extends PeriodQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pagina debe ser un entero' })
  @Min(1, { message: 'pagina debe ser mayor o igual que 1' })
  @Max(1000, { message: 'pagina no puede superar 1000' })
  pagina: number = 1;
}
