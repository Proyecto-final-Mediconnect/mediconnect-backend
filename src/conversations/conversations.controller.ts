import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { ConversationsService } from './conversations.service';
import { MessagesQueryDto } from './dto/messages-query.dto';
import { OpenConversationDto } from './dto/open-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { toRealtimeToken, type RealtimeToken } from './realtime-token';

/** Chat paciente–profesional (ENG-70). Sirve a los dos roles. */
@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  /** Mis conversaciones y con quién puedo abrir una nueva. */
  @Get('me')
  listMine(@Req() req: Request) {
    const { userId } = requireAuth(req);
    return this.conversations.listMine(userId);
  }

  /**
   * El access token de la sesión, para que la web se suscriba a Realtime
   * (ADR-011) con `realtime.setAuth()`.
   *
   * La web guarda la sesión en cookies httpOnly y su JavaScript no puede leer
   * el token; sin él, Realtime evalúa RLS como `anon` y no entrega nada. Es una
   * concesión consciente: un XSS podría leer este token mientras dure (1 h). El
   * refresh token **no** sale nunca de la cookie, así que no se puede estirar la
   * sesión desde afuera. La app mobile ya tiene el token y no lo necesita.
   *
   * Deuda: un token dedicado de vida corta (5–10 min, con refresco por este
   * mismo endpoint) apenas se pueda firmar uno que Realtime acepte. CORS ya
   * limita la lectura cross-origin a `WEB_ORIGIN`.
   */
  @Get('realtime-token')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  realtimeToken(@Req() req: Request): RealtimeToken {
    const { accessToken } = requireAuth(req);
    return toRealtimeToken(accessToken);
  }

  /**
   * Abre la conversación con alguien con quien hubo turno, o devuelve la que ya
   * existe. 200 y no 201: el resultado es el mismo en los dos casos.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  open(@Req() req: Request, @Body() dto: OpenConversationDto) {
    const { userId } = requireAuth(req);
    return this.conversations.open(userId, dto.contraparteId);
  }

  @Get(':id/messages')
  listMessages(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: MessagesQueryDto,
  ) {
    const { userId } = requireAuth(req);
    return this.conversations.listMessages(userId, id, query.antesDe);
  }

  /**
   * Manda un mensaje. 30 por minuto alcanza para una charla rápida y corta un
   * script que inunde la bandeja de la otra persona.
   */
  @Post(':id/messages')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  send(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SendMessageDto,
  ) {
    const { userId } = requireAuth(req);
    return this.conversations.send(userId, id, dto.contenido);
  }

  /** Marca como leído lo que mandó la otra persona. */
  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const { userId } = requireAuth(req);
    await this.conversations.markRead(userId, id);
  }

  /**
   * "Borrar chat": lo oculta solo de mi bandeja. La otra persona lo sigue viendo
   * y los mensajes no se borran. Uno sin mensajes sí se elimina.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hide(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const { userId } = requireAuth(req);
    await this.conversations.hide(userId, id);
  }
}
