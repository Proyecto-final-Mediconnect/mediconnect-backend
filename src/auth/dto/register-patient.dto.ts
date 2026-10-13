import { Equals, IsEmail, IsString, Matches, MinLength } from 'class-validator';
import { LEGAL_NOT_ACCEPTED_MESSAGE, LEGAL_VERSION } from '../../legal/legal';
import { Match } from '../decorators/match.decorator';

export class RegisterPatientDto {
  @IsEmail({}, { message: 'El email no tiene un formato válido' })
  email!: string;

  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @Matches(/[A-Z]/, {
    message: 'La contraseña debe incluir al menos una mayúscula',
  })
  @Matches(/[0-9]/, {
    message: 'La contraseña debe incluir al menos un número',
  })
  password!: string;

  @IsString()
  @Match('password', { message: 'Las contraseñas no coinciden' })
  passwordConfirmation!: string;

  /**
   * Versión de los textos legales que aceptó al registrarse (ENG-140). Tiene que
   * ser la vigente: es la prueba del consentimiento para tratar datos de salud
   * (Ley 25.326, art. 7), y se valida acá además del checkbox de la web.
   */
  @Equals(LEGAL_VERSION, { message: LEGAL_NOT_ACCEPTED_MESSAGE })
  acceptedLegalVersion!: string;
}
