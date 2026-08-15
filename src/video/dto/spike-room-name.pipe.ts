import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { SPIKE_ROOM_PREFIX } from '../daily.config';

/**
 * Acepta únicamente nombres de sala generados por este spike
 * (`spike-eng51-<8 hex>`), y rechaza cualquier otro.
 *
 * No es cosmético. El nombre entra crudo en la URL de la API de Daily, y los
 * endpoints del spike incluyen un DELETE: sin este filtro, `DELETE
 * /video/spike/rooms/<lo-que-sea>` podría borrar cualquier sala del dominio,
 * incluida una de una consulta real cuando exista ENG-56. Restringir por prefijo
 * deja al spike encerrado en su propio namespace.
 */
@Injectable()
export class SpikeRoomNamePipe implements PipeTransform<string, string> {
  private static readonly PATTERN = new RegExp(
    `^${SPIKE_ROOM_PREFIX}-[0-9a-f]{8}$`,
  );

  transform(value: string): string {
    if (!SpikeRoomNamePipe.PATTERN.test(value)) {
      throw new BadRequestException(
        'El nombre de sala no corresponde a una sala de prueba de ENG-51.',
      );
    }
    return value;
  }
}
