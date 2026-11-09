import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

/** EP-08 — Chat paciente–profesional (ENG-70). */
@Module({
  imports: [NotificationsModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, ChatAttachmentsService],
})
export class ConversationsModule {}
