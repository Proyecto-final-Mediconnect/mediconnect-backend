import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
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
  @IsDateString(
    { strict: true },
    { message: 'La fecha tiene que tener el formato AAAA-MM-DD.' },
  )
  documentDate?: string;

  @Transform(trimmed)
  @IsOptional()
  @IsString()
  @MaxLength(120, {
    message: 'La institución no puede pasar los 120 caracteres.',
  })
  sourceInstitution?: string;
}
