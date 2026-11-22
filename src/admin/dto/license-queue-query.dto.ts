import { IsIn, IsOptional } from 'class-validator';

/** Los estados que muestra la cola de matrículas (ENG-192). */
export const LICENSE_QUEUE_STATUSES = [
  'PENDIENTE_VALIDACION_MATRICULA',
  'VALIDADO',
  'RECHAZADO',
] as const;
export type LicenseQueueStatus = (typeof LICENSE_QUEUE_STATUSES)[number];

/** `GET /admin/professionals/licenses?status=…`. Sin `status`, los pendientes. */
export class LicenseQueueQueryDto {
  @IsOptional()
  @IsIn(LICENSE_QUEUE_STATUSES, {
    message: 'El estado tiene que ser pendiente, validado o rechazado.',
  })
  status?: LicenseQueueStatus;
}
