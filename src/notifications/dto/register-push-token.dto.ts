import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { EXPO_PUSH_TOKEN_PATTERN } from '../push.service';

/** `POST /push-tokens` (ENG-71): el token de Expo Push del dispositivo. */
export class RegisterPushTokenDto {
  @IsString()
  @MaxLength(200)
  @Matches(EXPO_PUSH_TOKEN_PATTERN, {
    message: 'El token de notificaciones no es válido.',
  })
  token!: string;

  @IsOptional()
  @IsIn(['android', 'ios'])
  platform?: 'android' | 'ios';
}
