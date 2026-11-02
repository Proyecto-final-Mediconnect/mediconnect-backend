import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requireAuth } from '../common/http/require-auth';
import { UploadPatientDocumentDto } from './dto/upload-patient-document.dto';
import {
  MAX_DOCUMENT_BYTES,
  PatientDocumentsService,
  type UploadedDocumentFile,
} from './patient-documents.service';

/**
 * Documentación clínica previa que aporta el paciente (ENG-164).
 *
 * Las rutas `patients/me/...` van antes que `patients/:patientId/...` en el mismo
 * controller para que `me` nunca se tome como un id.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class PatientDocumentsController {
  constructor(private readonly documents: PatientDocumentsService) {}

  /**
   * Sube un documento propio: el archivo en `file` (PDF, JPG o PNG, hasta
   * 10 MB) y sus datos como campos del multipart.
   *
   * Rate limit como el alta de entradas de la HC: cada subida deja una fila y un
   * archivo que no se pueden borrar.
   */
  @Post('patients/me/documents')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  // Un byte más que el tope: lo que pase de 10 MB lo corta Multer, y el mensaje
  // claro lo da el service para el caso justo en el borde.
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_BYTES + 1 } }),
  )
  upload(
    @Req() req: Request,
    @UploadedFile() file: UploadedDocumentFile | undefined,
    @Body() dto: UploadPatientDocumentDto,
  ) {
    const { userId, accessToken } = requireAuth(req);
    if (!file) {
      throw new BadRequestException('Adjuntá el archivo en el campo "file".');
    }
    return this.documents.upload(accessToken, userId, file, dto);
  }

  @Get('patients/me/documents')
  listMine(@Req() req: Request) {
    const { userId } = requireAuth(req);
    return this.documents.listForPatient(userId);
  }

  /** Retira un documento propio: deja de verse, pero queda registrado. */
  @Delete('patients/me/documents/:documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  withdraw(
    @Req() req: Request,
    @Param('documentId', new ParseUUIDPipe({ version: '4' }))
    documentId: string,
  ) {
    const { userId } = requireAuth(req);
    return this.documents.withdraw(userId, documentId);
  }

  /** Los documentos de un paciente, para un profesional que puede leer su HC. */
  @Get('patients/:patientId/documents')
  listForPatient(
    @Req() req: Request,
    @Param('patientId', new ParseUUIDPipe({ version: '4' }))
    patientId: string,
  ) {
    const { userId } = requireAuth(req);
    return this.documents.listFor(userId, patientId);
  }

  /** Una URL firmada de cinco minutos para abrir el archivo. */
  @Get('patient-documents/:documentId/download')
  download(
    @Req() req: Request,
    @Param('documentId', new ParseUUIDPipe({ version: '4' }))
    documentId: string,
  ) {
    const { userId, accessToken } = requireAuth(req);
    return this.documents.downloadUrl(userId, accessToken, documentId);
  }
}
