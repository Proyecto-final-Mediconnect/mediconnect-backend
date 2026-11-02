import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class ReviewPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;
}

export class ModerationQueryDto extends ReviewPageQueryDto {
  @IsOptional()
  @IsIn(['PENDIENTE_MODERACION', 'APROBADA', 'RECHAZADA'])
  status: 'PENDIENTE_MODERACION' | 'APROBADA' | 'RECHAZADA' =
    'PENDIENTE_MODERACION';
}
