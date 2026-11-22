import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export const PROFESSIONAL_STATUSES = [
  'PENDIENTE_VALIDACION_MATRICULA',
  'VALIDADO',
  'RECHAZADO',
  'SUSPENDIDO',
] as const;
export type ProfessionalStatus = (typeof PROFESSIONAL_STATUSES)[number];

/** Profesionales por página en el listado del administrador. */
export const ADMIN_PROFESSIONALS_PAGE_SIZE = 20;

/** `GET /admin/professionals?status=&q=&page=` (ENG-241). */
export class ListProfessionalsAdminQueryDto {
  @IsOptional()
  @IsIn(PROFESSIONAL_STATUSES, { message: 'Ese estado no existe.' })
  status?: ProfessionalStatus;

  /** Busca por nombre, apellido o matrícula. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100, { message: 'La búsqueda es demasiado larga.' })
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La página tiene que ser un número.' })
  @Min(1, { message: 'La página empieza en 1.' })
  page?: number;
}
