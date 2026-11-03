import { IsBoolean } from 'class-validator';

/** `PUT /me/preferences` (ENG-86): oposición a los recordatorios por email. */
export class UpdatePreferencesDto {
  @IsBoolean({
    message: 'recordatoriosPorEmail tiene que ser verdadero o falso.',
  })
  recordatoriosPorEmail!: boolean;
}
