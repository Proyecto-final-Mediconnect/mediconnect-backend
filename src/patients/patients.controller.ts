import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PeriodQueryDto } from '../common/time/period.dto';
import { UpdatePatientProfileDto } from './dto/update-patient-profile.dto';
import { UpdateVitalInfoDto } from './dto/update-vital-info.dto';
import { InvalidIpsError, readIps } from './ips/read-ips';
import { PatientSummaryService } from './patient-summary.service';
import { PatientsService } from './patients.service';

/** JwtAuthGuard garantiza `user` y `accessToken`; este helper lo hace explícito
 *  para TypeScript sin `!` repartidos por los handlers. */
function requireAuth(req: Request): { userId: string; accessToken: string } {
  if (!req.user?.id || !req.accessToken) {
    throw new UnauthorizedException('No se encontró un token de sesión.');
  }
  return { userId: req.user.id, accessToken: req.accessToken };
}

@Controller('patients')
@UseGuards(JwtAuthGuard)
export class PatientsController {
  constructor(
    private readonly patients: PatientsService,
    private readonly summaries: PatientSummaryService,
  ) {}

  /**
   * El resumen del inicio (ENG-198): consultas, pagos y accesos a su
   * información del período. Sin `from`/`to`, los últimos 30 días.
   */
  @Get('me/summary')
  getMySummary(@Req() req: Request, @Query() query: PeriodQueryDto) {
    const { userId } = requireAuth(req);
    return this.summaries.summary(userId, query);
  }

  @Get('me')
  getMyProfile(@Req() req: Request) {
    const { userId, accessToken } = requireAuth(req);
    return this.patients.getMyProfile(accessToken, userId);
  }

  // PUT (no PATCH): el paciente envía SIEMPRE los campos del perfil (los cinco
  // del formulario). La fila no existe hasta la primera carga, así que el upsert
  // necesita todos los obligatorios; un PATCH parcial no podría crearla. `address`
  // no forma parte de este perfil (no está en los criterios de ENG-47): no se
  // gestiona acá y conserva su valor si otro flujo lo cargara.
  @Put('me')
  updateMyProfile(@Req() req: Request, @Body() dto: UpdatePatientProfileDto) {
    const { userId, accessToken } = requireAuth(req);
    return this.patients.updateMyProfile(accessToken, userId, dto);
  }

  /**
   * Los datos vitales del MediPass (ENG-134; los carga ENG-136).
   *
   * Endpoint aparte y no parte de `PUT me` porque las reglas son distintas: los
   * cinco campos del perfil son obligatorios y crean la fila, y estos seis son
   * opcionales y la suponen. Mezclarlos en un PUT dejaría un cuerpo con dos
   * contratos adentro, y obligaría a tocar el formulario de ENG-47.
   *
   * `PUT` y no `PATCH`: reemplaza el bloque entero, que es lo que permite
   * borrar una alergia. Ver `UpdateVitalInfoDto`.
   *
   * Devuelve el perfil completo, igual que `PUT me`, para que la pantalla se
   * quede con lo que quedó guardado sin pedirlo de nuevo.
   */
  /**
   * Lee un resumen de salud IPS de Argentina que trae el paciente y propone qué
   * cargar en su MediPass (ENG-246, ADR-022). **No guarda nada:** el paciente
   * elige qué confirmar y eso se guarda con `PUT me/vital`.
   *
   * El cuerpo es el documento FHIR tal cual (JSON, hasta el límite de 100 kB del
   * body parser). No se valida con un DTO: es un recurso externo, y `readIps`
   * lee lo que entiende e ignora el resto.
   *
   * Devuelve si el DNI del documento coincide con el del paciente, y no el DNI:
   * la pantalla solo necesita saber si avisar.
   */
  @Post('me/ips/preview')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async previewIps(@Req() req: Request, @Body() body: unknown) {
    const { userId, accessToken } = requireAuth(req);
    let preview;
    try {
      preview = readIps(body);
    } catch (error) {
      if (error instanceof InvalidIpsError) {
        throw new BadRequestException(error.message);
      }
      throw new BadRequestException(
        'No pudimos leer el archivo. Revisá que sea un resumen de salud IPS.',
      );
    }
    const perfil = await this.patients.getMyProfile(accessToken, userId);
    const { dni, ...documento } = preview.documento;
    return {
      ...preview,
      documento: {
        ...documento,
        // `null`: el documento no trae DNI o el paciente todavía no cargó el suyo.
        dniCoincide:
          dni && perfil.dni ? dni === perfil.dni.replace(/\D/g, '') : null,
      },
    };
  }

  @Put('me/vital')
  updateMyVitalInfo(@Req() req: Request, @Body() dto: UpdateVitalInfoDto) {
    const { userId, accessToken } = requireAuth(req);
    return this.patients.updateMyVitalInfo(accessToken, userId, dto);
  }
}
