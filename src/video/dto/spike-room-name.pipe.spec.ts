import { BadRequestException } from '@nestjs/common';
import { SPIKE_ROOM_PREFIX } from '../daily.config';
import { SpikeRoomNamePipe } from './spike-room-name.pipe';

describe('SpikeRoomNamePipe', () => {
  const pipe = new SpikeRoomNamePipe();

  it('acepta una sala generada por el spike', () => {
    const name = `${SPIKE_ROOM_PREFIX}-a1b2c3d4`;
    expect(pipe.transform(name)).toBe(name);
  });

  it.each([
    ['una sala ajena', 'consulta-de-otro'],
    ['el prefijo solo', SPIKE_ROOM_PREFIX],
    ['sufijo con largo distinto', `${SPIKE_ROOM_PREFIX}-a1b2c3`],
    ['sufijo no hexadecimal', `${SPIKE_ROOM_PREFIX}-zzzzzzzz`],
    // El punto del pipe: que un nombre con `../` no pueda salirse del recurso
    // /rooms/:name al armar la URL de la API de Daily.
    ['un intento de path traversal', `${SPIKE_ROOM_PREFIX}-a1b2c3d4/../otra`],
    ['un prefijo simulado', `no-${SPIKE_ROOM_PREFIX}-a1b2c3d4`],
    ['vacío', ''],
  ])('rechaza %s', (_caso, value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });
});
