import { IsOptional, Matches } from 'class-validator';

const FECHA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** `?from=YYYY-MM-DD&to=YYYY-MM-DD` de los reportes (ENG-194, ENG-198). */
export class PeriodQueryDto {
  @IsOptional()
  @Matches(FECHA, { message: 'from debe tener el formato YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(FECHA, { message: 'to debe tener el formato YYYY-MM-DD' })
  to?: string;
}
