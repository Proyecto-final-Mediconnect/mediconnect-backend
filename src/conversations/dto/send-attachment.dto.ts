import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { MESSAGE_MAX_LENGTH } from './send-message.dto';

/** `POST /conversations/:id/attachments` (ENG-102): el texto que acompaña al archivo. */
export class SendAttachmentDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'contenido debe ser texto' })
  @MaxLength(MESSAGE_MAX_LENGTH, {
    message: `El mensaje no puede superar los ${MESSAGE_MAX_LENGTH} caracteres`,
  })
  contenido?: string;
}
