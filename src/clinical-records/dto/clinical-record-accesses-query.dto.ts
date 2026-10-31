import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** `?pagina=N` del historial de accesos a la HC (ENG-165). */
export class ClinicalRecordAccessesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pagina debe ser un entero' })
  @Min(1, { message: 'pagina debe ser mayor o igual que 1' })
  @Max(1000, { message: 'pagina no puede superar 1000' })
  pagina: number = 1;
}
