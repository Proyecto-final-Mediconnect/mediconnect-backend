import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListProfessionalsQueryDto } from './list-professionals-query.dto';

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
