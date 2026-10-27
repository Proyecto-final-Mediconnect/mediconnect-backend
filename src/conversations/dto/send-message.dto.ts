import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Largo máximo de un mensaje. Alcanza para un párrafo largo y corta el pegado de un documento entero. */
export const MESSAGE_MAX_LENGTH = 2000;

/** `POST /conversations/:id/messages` (ENG-70). */
export class SendMessageDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'contenido debe ser texto' })
  @IsNotEmpty({ message: 'El mensaje no puede estar vacío' })
  @MaxLength(MESSAGE_MAX_LENGTH, {
    message: `El mensaje no puede superar los ${MESSAGE_MAX_LENGTH} caracteres`,
  })
  contenido!: string;
}
