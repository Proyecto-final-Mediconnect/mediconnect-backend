import { IsEmail, IsString, Matches, MinLength } from 'class-validator';
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
}
