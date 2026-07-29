import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpdateProfessionalProfileDto } from './dto/update-professional-profile.dto';
import { ProfessionalsService } from './professionals.service';

/**
 * Tope DURO del interceptor, deliberadamente por encima del límite real de la foto
 * (`MAX_PHOTO_BYTES` = 2 MB, que valida el service). Multer corta acá para que un
 * archivo gigante no se bufferee en memoria, pero deja pasar la banda 2–8 MB para
 * que el 400 lo dé el service, que puede explicar el límite. Cuando corta Multer,
 * `@nestjs/platform-express` responde 413 y `PayloadTooLargeFilter` traduce el
 * mensaje (antes salía el "File too large" crudo, en inglés).
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Subconjunto de los campos que Multer adjunta al archivo subido. Evita
 *  depender de `@types/multer` (Express.Multer.File) solo por estos 3 campos. */
interface UploadedPhoto {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** JwtAuthGuard garantiza `user` y `accessToken`; este helper lo hace explícito
 *  para TypeScript sin `!` repartidos por los handlers. */
function requireAuth(req: Request): { userId: string; accessToken: string } {
  if (!req.user?.id || !req.accessToken) {
    throw new UnauthorizedException('No se encontró un token de sesión.');
  }
  return { userId: req.user.id, accessToken: req.accessToken };
}

@Controller('professionals')
@UseGuards(JwtAuthGuard)
export class ProfessionalsController {
  constructor(private readonly professionals: ProfessionalsService) {}

  @Get('me')
  getMyProfile(@Req() req: Request) {
    const { userId, accessToken } = requireAuth(req);
    return this.professionals.getMyProfile(accessToken, userId);
  }

  @Patch('me')
  updateMyProfile(
    @Req() req: Request,
    @Body() dto: UpdateProfessionalProfileDto,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.professionals.updateMyProfile(accessToken, userId, dto);
  }

  @Post('me/photo')
  @UseInterceptors(
    FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  uploadPhoto(
    @Req() req: Request,
    @UploadedFile() file: UploadedPhoto | undefined,
  ) {
    const { userId, accessToken } = requireAuth(req);
    if (!file) {
      throw new BadRequestException('Adjuntá una imagen en el campo "photo".');
    }
    return this.professionals.uploadPhoto(accessToken, userId, file);
  }
}
