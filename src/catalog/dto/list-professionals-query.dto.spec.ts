import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ListProfessionalsQueryDto,
  MAX_SPECIALTY_FILTERS,
} from './list-professionals-query.dto';

const CARDIO = '33333333-3333-4333-8333-333333333333';
const PEDIATRIA = '55555555-5555-4555-8555-555555555555';

/** Replica lo que hace el ValidationPipe global sobre el query string. */
function validate(raw: Record<string, unknown>) {
  const dto = plainToInstance(ListProfessionalsQueryDto, raw, {
    enableImplicitConversion: false,
  });
  return { dto, errors: validateSync(dto, { whitelist: true }) };
}

function propertiesWithErrors(raw: Record<string, unknown>) {
  return validate(raw).errors.map((e) => e.property);
}

describe('ListProfessionalsQueryDto', () => {
  it('aplica los defaults de ENG-49 sin query params', () => {
    const { dto, errors } = validate({});

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it('convierte los query params (siempre string) a número', () => {
    const { dto, errors } = validate({
      page: '2',
      limit: '10',
      minPrice: '1500.50',
      maxPrice: '9000',
    });

    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({
      page: 2,
      limit: 10,
      minPrice: 1500.5,
      maxPrice: 9000,
    });
  });

  it.each([
    ['page en 0', { page: '0' }, 'page'],
    ['page negativa', { page: '-1' }, 'page'],
    ['page no numérica', { page: 'abc' }, 'page'],
    ['page fraccionaria', { page: '1.5' }, 'page'],
    ['limit en 0', { limit: '0' }, 'limit'],
    ['limit por encima del techo', { limit: '51' }, 'limit'],
    ['precio negativo', { minPrice: '-1' }, 'minPrice'],
    ['precio no numérico', { maxPrice: 'gratis' }, 'maxPrice'],
    [
      'specialtyId que no es UUID',
      { specialtyId: 'cardiologia' },
      'specialtyId',
    ],
  ])('rechaza %s', (_caso, raw, property) => {
    expect(propertiesWithErrors(raw)).toContain(property);
  });

  describe('specialtyId — uno o más', () => {
    it('un solo valor llega como lista de uno', () => {
      // Express entrega un string cuando el parámetro aparece una sola vez. El
      // service tiene que ver siempre lo mismo, así que se normaliza acá.
      const { dto, errors } = validate({ specialtyId: CARDIO });

      expect(errors).toHaveLength(0);
      expect(dto.specialtyId).toEqual([CARDIO]);
    });

    it('el parámetro repetido acumula especialidades', () => {
      const { dto, errors } = validate({ specialtyId: [CARDIO, PEDIATRIA] });

      expect(errors).toHaveLength(0);
      expect(dto.specialtyId).toEqual([CARDIO, PEDIATRIA]);
    });

    it('descarta repetidos', () => {
      const { dto } = validate({ specialtyId: [CARDIO, CARDIO, PEDIATRIA] });

      expect(dto.specialtyId).toEqual([CARDIO, PEDIATRIA]);
    });

    it('sin el parámetro queda indefinido, no lista vacía', () => {
      // El service distingue los dos casos: `undefined` es "sin filtro".
      expect(validate({}).dto.specialtyId).toBeUndefined();
    });

    it('rechaza la lista si UN valor no es UUID', () => {
      // Si alcanzara con que uno esté bien, un id basura se filtraría en
      // silencio y el usuario vería resultados que no pidió.
      expect(
        propertiesWithErrors({ specialtyId: [CARDIO, 'cardiologia'] }),
      ).toContain('specialtyId');
    });

    it('acepta el tope de especialidades y rechaza una más', () => {
      const uuids = Array.from(
        { length: MAX_SPECIALTY_FILTERS + 1 },
        (_, i) =>
          `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
      );

      expect(
        propertiesWithErrors({ specialtyId: uuids.slice(0, -1) }),
      ).toHaveLength(0);
      expect(propertiesWithErrors({ specialtyId: uuids })).toContain(
        'specialtyId',
      );
    });
  });

  it('acepta el limit en el techo permitido', () => {
    expect(propertiesWithErrors({ limit: '50' })).toHaveLength(0);
  });

  it('rechaza un rango de precio invertido', () => {
    expect(
      propertiesWithErrors({ minPrice: '9000', maxPrice: '1000' }),
    ).toContain('maxPrice');
  });

  it('acepta un rango de precio de un solo valor', () => {
    expect(
      propertiesWithErrors({ minPrice: '5000', maxPrice: '5000' }),
    ).toHaveLength(0);
  });

  it('acepta cada extremo del rango por separado', () => {
    expect(propertiesWithErrors({ minPrice: '5000' })).toHaveLength(0);
    expect(propertiesWithErrors({ maxPrice: '5000' })).toHaveLength(0);
  });
});
