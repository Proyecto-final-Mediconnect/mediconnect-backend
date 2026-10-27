import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * `GET /medipass/me/historial?pagina=N` (ENG-76). Llega como string en la query,
 * de ahí el `@Type`: sin él `@IsInt` rechazaría `"2"`.
 */
export class MediPassHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pagina debe ser un entero' })
  @Min(1, { message: 'pagina debe ser mayor o igual que 1' })
  @Max(1000, { message: 'pagina no puede superar 1000' })
  pagina: number = 1;
}
