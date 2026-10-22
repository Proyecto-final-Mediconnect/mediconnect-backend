import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { CancellationPolicyService } from './cancellation-policy.service';
import { UpdateCancellationPolicyDto } from './dto/update-cancellation-policy.dto';
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

@Controller('professionals')
@UseGuards(JwtAuthGuard)
export class ProfessionalsController {
  constructor(
    private readonly professionals: ProfessionalsService,
    private readonly cancellationPolicy: CancellationPolicyService,
  ) {}

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

  /**
   * La política de cancelación del profesional (ENG-67, HU-26).
   *
   * Devuelve siempre tres valores, con `configured: false` cuando son el default.
   * No crea la fila: abrir la pantalla no es configurar una política.
   */
  @Get('me/cancellation-policy')
  getMyCancellationPolicy(@Req() req: Request) {
    const { userId } = requireAuth(req);
    return this.cancellationPolicy.getMyPolicy(userId);
  }

  /**
   * Reemplaza la política de cancelación.
   *
   * `PUT` y no `PATCH` —a diferencia del perfil, que es parcial a propósito—
   * porque una política a medias no se puede evaluar: sin el porcentaje de la
   * ventana intermedia no hay forma de decidir cuánto devolverle a un paciente
   * que cancela ahí. Se reemplaza entera o no se toca.
   */
  @Put('me/cancellation-policy')
  replaceMyCancellationPolicy(
    @Req() req: Request,
    @Body() dto: UpdateCancellationPolicyDto,
  ) {
    const { userId } = requireAuth(req);
    return this.cancellationPolicy.replaceMyPolicy(userId, dto);
  }
}
