import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'El email no tiene un formato válido' })
  email!: string;

  @IsString()
  @IsNotEmpty({ message: 'Ingresá tu contraseña' })
  password!: string;
}
