import {
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

const SEIS_DIGITOS = /^\d{6}$/;
const MENSAJE_CODIGO = 'El código son los 6 números que muestra la app.';

/** Un código TOTP de la app autenticadora (ENG-88). */
export class MfaCodeDto {
  @IsString({ message: MENSAJE_CODIGO })
  @Matches(SEIS_DIGITOS, { message: MENSAJE_CODIGO })
  code!: string;
}

/** `POST /me/mfa/enroll/verify`: el factor recién creado y su primer código. */
export class MfaEnrollVerifyDto extends MfaCodeDto {
  @IsUUID('4', { message: 'factorId no es válido.' })
  factorId!: string;
}

/**
 * `POST /auth/mobile/mfa/verify`: la app manda el token del primer paso, que la
 * web guarda en una cookie httpOnly, y el código.
 */
export class MobileMfaVerifyDto extends MfaCodeDto {
  @IsString()
  @IsNotEmpty({ message: 'Falta el token del primer paso.' })
  @MaxLength(4096)
  mfaToken!: string;
}
