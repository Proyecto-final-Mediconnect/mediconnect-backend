import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CancelByProfessionalDto,
  MAX_CANCELLATION_REASON_LENGTH,
  MIN_CANCELLATION_REASON_LENGTH,
} from './cancel-by-professional.dto';

function validate(body: unknown) {
  const dto = plainToInstance(CancelByProfessionalDto, body);
  return { dto, errors: validateSync(dto) };
}

describe('CancelByProfessionalDto (ENG-204)', () => {
  it('acepta un motivo válido y le recorta los espacios', () => {
    const { dto, errors } = validate({
      reason: '   Tengo un congreso ese día.  ',
    });
    expect(errors).toHaveLength(0);
    expect(dto.reason).toBe('Tengo un congreso ese día.');
  });

  it.each([
    ['sin motivo', {}],
    ['motivo vacío', { reason: '' }],
    ['solo espacios', { reason: ' '.repeat(30) }],
    ['muy corto', { reason: 'x'.repeat(MIN_CANCELLATION_REASON_LENGTH - 1) }],
    ['muy largo', { reason: 'x'.repeat(MAX_CANCELLATION_REASON_LENGTH + 1) }],
    ['no es texto', { reason: 12345678901 }],
  ])('rechaza %s', (_caso, body) => {
    expect(validate(body).errors.length).toBeGreaterThan(0);
  });

  it('acepta el largo mínimo y el máximo exactos', () => {
    expect(
      validate({ reason: 'x'.repeat(MIN_CANCELLATION_REASON_LENGTH) }).errors,
    ).toHaveLength(0);
    expect(
      validate({ reason: 'x'.repeat(MAX_CANCELLATION_REASON_LENGTH) }).errors,
    ).toHaveLength(0);
  });
});
