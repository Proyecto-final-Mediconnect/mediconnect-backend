import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Recorta el valor antes de validar.
 *
 * Va antes de `@IsNotEmpty()` a propósito: sin esto, `"   "` pasaría la
 * validación y quedaría un asiento con un motivo en blanco — y como la tabla es
 * append-only, esa fila no se puede borrar nunca.
 */
export const trimmed = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * Los cuatro campos clínicos del asiento, compartidos por el alta (ENG-58) y por
 * la corrección (ENG-100).
 *
 * Están acá y no duplicados en cada DTO porque **son el mismo contenido**: una
 * corrección no es un parche sobre la entrada original, es el asiento completo
 * escrito de nuevo bien. Si los límites de longitud divergieran entre los dos
 * formularios, habría textos que se pueden escribir pero no corregir.
 *
 * El formulario es **estructurado y no un textarea libre**, y eso no es una
 * preferencia de UI: el `content` se guarda como recurso FHIR R5 (ADR-013) y de
 * ahí sale la interoperabilidad del MediPass. Un párrafo suelto no se puede
 * mapear a nada; cuatro campos con significado propio, sí.
 */
export abstract class ClinicalEntryContentDto {
  /** Motivo de consulta. Es el único obligatorio: un asiento sin motivo no dice
   *  nada, y los otros tres pueden no aplicar según el tipo de entrada. */
  @trimmed()
  @IsString()
  @IsNotEmpty({ message: 'El motivo es obligatorio' })
  @MaxLength(2000, {
    message: 'El motivo no puede superar los 2000 caracteres',
  })
  reason!: string;

  /** Evolución y hallazgos. */
  @trimmed()
  @IsOptional()
  @IsString()
  @MaxLength(5000, {
    message: 'La evolución no puede superar los 5000 caracteres',
  })
  findings?: string;

  @trimmed()
  @IsOptional()
  @IsString()
  @MaxLength(2000, {
    message: 'El diagnóstico no puede superar los 2000 caracteres',
  })
  diagnosis?: string;

  /** Plan o indicaciones. */
  @trimmed()
  @IsOptional()
  @IsString()
  @MaxLength(5000, {
    message: 'El plan no puede superar los 5000 caracteres',
  })
  plan?: string;
}
