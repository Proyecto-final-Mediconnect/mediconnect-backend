import { Equals, IsString } from 'class-validator';

/** La frase que hay que escribir para dar de baja la cuenta (ENG-86). */
export const FRASE_DE_BAJA = 'ELIMINAR MI CUENTA';

const MENSAJE = `Escribí "${FRASE_DE_BAJA}" para confirmar.`;

/**
 * `DELETE /me` (ENG-86). La baja no tiene vuelta atrás, así que se pide
 * escribir una frase: un doble click o un request armado sin querer no alcanza.
 */
export class DeleteAccountDto {
  @IsString({ message: MENSAJE })
  @Equals(FRASE_DE_BAJA, { message: MENSAJE })
  confirmacion!: string;
}
