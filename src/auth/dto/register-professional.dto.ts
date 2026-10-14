import {
  Equals,
  IsEmail,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';
import { LEGAL_NOT_ACCEPTED_MESSAGE, LEGAL_VERSION } from '../../legal/legal';
import { Match } from '../decorators/match.decorator';

export class RegisterProfessionalDto {
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

  @IsString()
  @Length(2, 60, { message: 'El nombre debe tener entre 2 y 60 caracteres' })
  firstName!: string;

  @IsString()
  @Length(2, 60, { message: 'El apellido debe tener entre 2 y 60 caracteres' })
  lastName!: string;

  @IsString()
  @Length(2, 80, {
    message: 'La especialidad debe tener entre 2 y 80 caracteres',
  })
  specialty!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9./-]{3,20}$/, {
    message: 'El número de matrícula no tiene un formato válido',
  })
  licenseNumber!: string;

  /**
   * Versión de los textos legales que aceptó al registrarse (ENG-140). Tiene que
   * ser la vigente: es la prueba del consentimiento para tratar datos de salud
   * (Ley 25.326, art. 7), y se valida acá además del checkbox de la web.
   *
   * Esto cubre el registro **por esta API**, no es la garantía de que nadie se
   * registre sin aceptar: un `signUp` directo contra Supabase Auth con la anon
   * key no pasa por acá y el trigger `on_auth_user_created` crea el perfil
   * igual. Lo que lo cierra es `LegalAcceptedGuard`: sin aceptación vigente,
   * ninguna ruta autenticada (salvo `GET /me` y `POST /me/legal-acceptance`)
   * responde otra cosa que 403.
   */
  @Equals(LEGAL_VERSION, { message: LEGAL_NOT_ACCEPTED_MESSAGE })
  acceptedLegalVersion!: string;
}
