import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ClinicalEntryContentDto, trimmed } from './clinical-entry-content.dto';

/**
 * Corrección de una entrada ya escrita (ENG-100).
 *
 * ## Lleva el asiento COMPLETO, no solo el campo equivocado
 *
 * Los cuatro campos clínicos llegan enteros, igual que en el alta, y no como un
 * parche de los que cambiaron. Dos razones:
 *
 * 1. **Lo que se lee es la corrección.** Si trajera solo el campo corregido, la
 *    pantalla —y el MediPass, y cualquier sistema que reciba el export FHIR—
 *    tendría que reconstruir la versión vigente mezclando dos entradas. Ese
 *    merge es exactamente donde se cuela un error de interpretación sobre datos
 *    clínicos.
 * 2. **El recurso FHIR de cada entrada tiene que valer solo.** `content` es un
 *    `ClinicalImpression` completo; uno que dijera "el diagnóstico ahora es X" y
 *    nada más no es un recurso interpretable fuera de MediConnect.
 *
 * El registro original no se toca: sigue ahí, con su hash y su lugar en la
 * cadena. Eso es lo que pide la Ley 26.529 art. 15, y es la diferencia entre
 * corregir y editar.
 *
 * ## Lo que NO manda el cliente
 *
 * - `entryType`: es siempre `CORRECCION`. No es una opción del formulario.
 * - `correctsEntryId`: va en la URL, no en el cuerpo. Es el recurso sobre el que
 *   se actúa.
 * - `consultationId`: se hereda de la entrada corregida. Una corrección pertenece
 *   a la misma consulta que el asiento que corrige, y dejar que el cliente la
 *   eligiera permitiría colgar la corrección de otra consulta —dato que entra a
 *   la preimagen del hash y que después no se puede arreglar.
 * - `professionalId`, `createdAt`, `sequenceNumber`, los hashes: igual que en el
 *   alta.
 */
export class CorrectClinicalEntryDto extends ClinicalEntryContentDto {
  /**
   * Qué estaba mal en la entrada original.
   *
   * **Obligatorio, y es el campo que justifica que este endpoint exista.** Sin
   * él, una HC con dos asientos casi idénticos no se puede leer: el que la
   * audita ve dos versiones y no sabe cuál es el error ni por qué se rehízo.
   * Queda dentro del `content`, así que entra al hash y no se puede reescribir
   * después.
   */
  @trimmed()
  @IsString()
  @IsNotEmpty({
    message: 'Hay que indicar qué se está corrigiendo y por qué',
  })
  @MaxLength(1000, {
    message: 'El motivo de la corrección no puede superar los 1000 caracteres',
  })
  correctionReason!: string;
}
