import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { requireAuth } from '../common/http/require-auth';
import { ConversationsService } from './conversations.service';

/**
 * Que quien sube un archivo sea participante de la conversación **antes** de
 * que Multer lea el cuerpo: los guards corren antes que los interceptors, así
 * que un archivo a una conversación ajena no llega a bufferearse en memoria.
 * Una conversación ajena da 404, igual que una inexistente.
 */
@Injectable()
export class ChatParticipantGuard implements CanActivate {
  constructor(private readonly conversations: ConversationsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const { userId } = requireAuth(req);
    const id = req.params.id;
    if (typeof id !== 'string' || !isUUID(id)) {
      throw new BadRequestException('Identificador de conversación inválido.');
    }
    await this.conversations.assertParticipant(userId, id);
    return true;
  }
}
