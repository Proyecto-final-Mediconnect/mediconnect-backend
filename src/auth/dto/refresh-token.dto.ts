import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Cuerpo de `POST /auth/mobile/refresh` (ENG-114). En la web el refresh token
 * viaja en la cookie httpOnly; la app mobile lo guarda en `expo-secure-store` y
 * lo manda acá.
 */
export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty({ message: 'Falta el refresh token' })
  refreshToken!: string;
}
