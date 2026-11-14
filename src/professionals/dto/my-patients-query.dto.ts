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
import type {
  LastFilter,
  MyPatientsOrder,
  NextFilter,
} from '../my-patients.service';

const ORDENES: MyPatientsOrder[] = [
  'ULTIMA_CONSULTA',
  'PROXIMO_TURNO',
  'CONSULTAS',
  'PACIENTE_DESDE',
  'NOMBRE',
];
const PROXIMOS: NextFilter[] = ['CON_PROXIMO', 'SIN_PROXIMO'];
const ULTIMAS: LastFilter[] = ['30D', '90D', 'MAS_DE_6M', 'NUNCA'];

/** `?q&pagina&orden&dir&proximo&ultima` de "Mis pacientes" (ENG-197). */
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

  @IsOptional()
  @IsIn(ORDENES, { message: 'orden no es válido' })
  orden?: MyPatientsOrder;

  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'dir debe ser asc o desc' })
  dir?: 'asc' | 'desc';

  @IsOptional()
  @IsIn(PROXIMOS, { message: 'proximo no es válido' })
  proximo?: NextFilter;

  @IsOptional()
  @IsIn(ULTIMAS, { message: 'ultima no es válido' })
  ultima?: LastFilter;
}
