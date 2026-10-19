import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Match } from '../decorators/match.decorator';

export class ResetPasswordDto {
  /** `token_hash` del enlace que llegó por email (ENG-142). */
  @IsString()
  @IsNotEmpty({ message: 'Falta el código del enlace de recuperación' })
  @MaxLength(256, {
    message: 'El código del enlace de recuperación no es válido',
  })
  tokenHash!: string;

  // Mismas reglas que el registro (RegisterPatientDto).
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
