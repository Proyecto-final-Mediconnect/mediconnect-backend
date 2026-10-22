import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { InAppNotificationsService } from './in-app-notifications.service';

/** La bandeja de avisos in-app del usuario autenticado (ENG-69). */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: InAppNotificationsService) {}

  /** Últimos avisos in-app y cuántos están sin leer. Sirve a cualquier rol. */
  @Get('me')
  listMine(@Req() req: Request) {
    const { userId } = requireAuth(req);
    return this.notifications.listMine(userId);
  }

  /** Marca un aviso propio como leído. */
  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const { userId } = requireAuth(req);
    await this.notifications.markRead(userId, id);
  }
}
