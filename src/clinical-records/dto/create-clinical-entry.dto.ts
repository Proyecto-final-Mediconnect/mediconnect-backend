import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Nueva entrada de historia clínica (ENG-58).
 *
 * El formulario es **estructurado y no un textarea libre**, y eso no es una
 * preferencia de UI: el `content` se guarda como recurso FHIR R5 (ADR-013) y de
 * ahí sale la interoperabilidad del MediPass. Un párrafo suelto no se puede
 * mapear a nada; cuatro campos con significado propio, sí.
 *
 * Lo que **no** manda el cliente, y por qué:
 *
 * - `professionalId`: es el `auth.uid()` del JWT. Es la autoría del asiento y
 *   entra a la preimagen del hash (Ley 26.529 art. 15). Aceptarlo del cuerpo
 *   dejaría firmar a nombre de otro.
 * - `createdAt`: lo fija el servidor en el momento de sellar. Entra al hash, así
 *   que aceptarlo permitiría antedatar una entrada con la cadena cerrando igual.
 * - `sequenceNumber`, `contentHash`, `previousHash`: los resuelve la cadena.
 *
 * `forbidNonWhitelisted` rechaza el request entero si alguno aparece.
 */

/** Valores del enum `entry_type` que puede elegir el profesional.
 *
 *  `CORRECCION` queda afuera: una corrección no se crea desde este formulario,
 *  necesita apuntar a la entrada que corrige y es ENG-100. */
export const SELECTABLE_ENTRY_TYPES = [
  'CONSULTA',
  'DIAGNOSTICO',
  'PRESCRIPCION',
  'ESTUDIO',
] as const;

export class CreateClinicalEntryDto {
  @IsIn([...SELECTABLE_ENTRY_TYPES], {
    message: 'El tipo de entrada no es válido',
  })
  entryType!: (typeof SELECTABLE_ENTRY_TYPES)[number];

  /** Motivo de consulta. Es el único obligatorio: un asiento sin motivo no dice
   *  nada, y los otros tres pueden no aplicar según el tipo de entrada. */
  @IsString()
  @MaxLength(2000, {
    message: 'El motivo no puede superar los 2000 caracteres',
  })
  reason!: string;

  /** Evolución y hallazgos. */
  @IsOptional()
  @IsString()
  @MaxLength(5000, {
    message: 'La evolución no puede superar los 5000 caracteres',
  })
  findings?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000, {
    message: 'El diagnóstico no puede superar los 2000 caracteres',
  })
  diagnosis?: string;

  /** Plan o indicaciones. */
  @IsOptional()
  @IsString()
  @MaxLength(5000, {
    message: 'El plan no puede superar los 5000 caracteres',
  })
  plan?: string;

  /**
   * Consulta que originó la entrada, si se escribe durante la videoconsulta.
   *
   * Opcional porque el criterio de aceptación pide el formulario disponible
   * **durante y después**: una entrada cargada al otro día no tiene una consulta
   * en curso de la que colgar, y no por eso deja de ser válida.
   */
  @IsOptional()
  @IsUUID('4', { message: 'El identificador de la consulta no es válido' })
  consultationId?: string;
}
