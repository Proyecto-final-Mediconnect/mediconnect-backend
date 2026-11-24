import { IsBoolean, IsInt, Max, Min } from 'class-validator';

/**
 * Lo que se exportó de la HC a PDF (ENG-231), para dejarlo en la auditoría.
 *
 * El PDF lo arma la web con las entradas que ya leyó (y que ya quedaron
 * auditadas como lectura). Esto registra además **quién la descargó** y qué
 * alcance tuvo: la historia completa o una parte filtrada.
 */
export class ExportClinicalRecordDto {
  /** Cuántos registros lleva el PDF. */
  @IsInt({ message: 'entryCount debe ser un entero' })
  @Min(0, { message: 'entryCount no puede ser negativo' })
  @Max(100_000, { message: 'entryCount es demasiado grande' })
  entryCount!: number;

  /** Si el PDF lleva solo lo que dejaron los filtros de la pantalla. */
  @IsBoolean({ message: 'filtered debe ser true o false' })
  filtered!: boolean;
}
