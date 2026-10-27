import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateCheckoutDto } from './create-checkout.dto';

function failedProps(body: object): string[] {
  return validateSync(plainToInstance(CreateCheckoutDto, body), {
    whitelist: true,
  }).map((e) => e.property);
}

describe('CreateCheckoutDto (ENG-172)', () => {
  it('acepta el cuerpo vacío que manda la web', () => {
    expect(failedProps({})).toEqual([]);
  });

  it.each(['web', 'app'])('acepta origen %s', (origen) => {
    expect(failedProps({ origen })).toEqual([]);
  });

  it.each(['mobile', '', 'APP', 1])('rechaza origen %p', (origen) => {
    expect(failedProps({ origen })).toEqual(['origen']);
  });
});
