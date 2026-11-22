import { Controller, Get, NotFoundException, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { INVALID_FILE_LINK, StoredFilesService } from './stored-files.service';

/** Un link nunca es tan largo: corta antes de intentar descifrar basura. */
const MAX_TOKEN_LENGTH = 2048;

/**
 * `GET /files?t=<link>` — abre un archivo cifrado (ENG-216).
 *
 * Sin `JwtAuthGuard`, como una URL firmada de Storage: se abre en una pestaña o
 * en un `<img>`, que no mandan el token. El link es la credencial: lo arma el
 * backend después de autorizar y auditar, dura cinco minutos y va cifrado.
 *
 * Va por query y no en el path porque el log de requests y Sentry descartan el
 * query string: el link no queda en ningún log nuestro.
 *
 * Headers, además de los de `securityHeaders` (`no-store`, `nosniff`):
 * - `Content-Security-Policy: default-src 'none'; sandbox`: si el archivo se
 *   muestra en el navegador, no puede ejecutar nada. Un PDF con JavaScript ya se
 *   rechaza al subir; esto es la segunda barrera.
 * - `Content-Disposition`: un documento se baja, como con la URL de Storage
 *   (`download: true`); en el chat, un PDF se baja y una foto se muestra.
 */
@Controller('files')
export class StoredFilesController {
  constructor(private readonly files: StoredFilesService) {}

  @Get()
  // Generoso: el chat pide una miniatura por foto al dibujar la conversación.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async open(@Query('t') token: unknown, @Res() res: Response): Promise<void> {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH
    ) {
      throw new NotFoundException(INVALID_FILE_LINK);
    }
    const file = await this.files.open(token);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.bytes.length));
    res.setHeader(
      'Content-Disposition',
      `${file.attachment ? 'attachment' : 'inline'}; filename="${file.filename}"`,
    );
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.status(200).end(file.bytes);
  }
}
