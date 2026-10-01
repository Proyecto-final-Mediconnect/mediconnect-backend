import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { ClinicalEntryContentDto } from './clinical-entry-content.dto';

/**
 * Nueva entrada de historia clínica (ENG-58).
 *
 * Los cuatro campos clínicos vienen de `ClinicalEntryContentDto`, que comparte
 * con la corrección de ENG-100.
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
 *  necesita apuntar a la entrada que corrige y va por
 *  `POST .../clinical-record/:entryId/corrections` (ENG-100). */
export const SELECTABLE_ENTRY_TYPES = [
  'CONSULTA',
  'DIAGNOSTICO',
  'PRESCRIPCION',
  'ESTUDIO',
] as const;

export class CreateClinicalEntryDto extends ClinicalEntryContentDto {
  @IsIn([...SELECTABLE_ENTRY_TYPES], {
    message: 'El tipo de entrada no es válido',
  })
  entryType!: (typeof SELECTABLE_ENTRY_TYPES)[number];

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
