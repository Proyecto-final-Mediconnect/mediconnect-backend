import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Cuántos documentos devuelve un listado si no se pide otra cosa. */
export const DEFAULT_DOCUMENTS_PAGE_SIZE = 50;
/** El tope por página, pida lo que pida el cliente. */
export const MAX_DOCUMENTS_PAGE_SIZE = 100;

/** Paginación de los listados de documentos; la respuesta sigue siendo un array. */
export class ListPatientDocumentsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DOCUMENTS_PAGE_SIZE)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
