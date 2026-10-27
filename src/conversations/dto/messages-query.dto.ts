import { IsOptional, IsUUID } from 'class-validator';

/**
 * `GET /conversations/:id/messages?antesDe=<id>` (ENG-70). Sin `antesDe` trae
 * los mensajes más recientes; con él, la página anterior a ese mensaje.
 */
export class MessagesQueryDto {
  @IsOptional()
  @IsUUID('4', { message: 'antesDe debe ser el id de un mensaje' })
  antesDe?: string;
}
