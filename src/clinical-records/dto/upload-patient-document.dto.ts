import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

/** Los tipos de documento que puede aportar el paciente (ENG-164). */
export const PATIENT_DOCUMENT_TYPES = [
  'ESTUDIO',
  'EPICRISIS',
  'INFORME',
  'RECETA',
  'OTRO',
] as const;
export type PatientDocumentType = (typeof PATIENT_DOCUMENT_TYPES)[number];

/** Recorta y convierte `""` en `undefined`: el multipart manda strings vacíos. */
const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

/**
 * `AAAA-MM-DD` de un día que existe y que no es futuro. Se compara como texto, sin
 * pasar por `Date` local: la fecha del estudio es un día de calendario y no un
 * instante, así que una zona horaria no puede correrla. Contra el día UTC, que
 * nunca va atrás del de Argentina: no rechaza el "hoy" de nadie.
 */
@ValidatorConstraint({ name: 'isPastOrTodayCalendarDate', async: false })
class IsPastOrTodayCalendarDate implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value // 2026-02-31 se corre a marzo
    ) {
      return false;
    }
    return value <= new Date().toISOString().slice(0, 10);
  }

  defaultMessage(): string {
    return 'La fecha tiene que tener el formato AAAA-MM-DD y no puede ser futura.';
  }
}

/**
 * Los datos que acompañan al archivo en `POST /patients/me/documents`. Van como
 * campos del multipart, así que todo llega como string.
 */
export class UploadPatientDocumentDto {
  @IsEnum(PATIENT_DOCUMENT_TYPES, {
    message:
      'El tipo tiene que ser estudio, epicrisis, informe, receta u otro.',
  })
  type!: PatientDocumentType;

  @Transform(trimmed)
  @IsString()
  @IsNotEmpty({ message: 'Ponele un nombre al documento.' })
  @MaxLength(120, { message: 'El nombre no puede pasar los 120 caracteres.' })
  title!: string;

  /** `AAAA-MM-DD`: la fecha del estudio, no la de la subida. */
  @Transform(trimmed)
  @IsOptional()
  @Validate(IsPastOrTodayCalendarDate)
  documentDate?: string;

  @Transform(trimmed)
  @IsOptional()
  @IsString()
  @MaxLength(120, {
    message: 'La institución no puede pasar los 120 caracteres.',
  })
  sourceInstitution?: string;
}
