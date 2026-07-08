import { IsEmail, IsString, Length, Matches, MinLength } from 'class-validator';
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
}
