import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OpenEmergencySessionDto } from './open-emergency-session.dto';

function instancia(obj: Record<string, unknown>): OpenEmergencySessionDto {
  return plainToInstance(OpenEmergencySessionDto, obj);
}

async function invalidProps(obj: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(instancia(obj));
  return errors.map((e) => e.property);
}

describe('OpenEmergencySessionDto', () => {
  const valid = { codigo: 'BCD23FGH', nombre: 'Dra. Paula Ferrer' };

  it('acepta datos válidos', async () => {
    expect(await invalidProps(valid)).toHaveLength(0);
  });

  it('normaliza el código como lo escribe una persona', async () => {
    // El código se dicta y se copia con guiones y en minúscula. La web ya lo
    // normaliza, pero el endpoint es público y también lo llama mobile.
    const dto = instancia({ ...valid, codigo: ' bcd2-3fgh ' });

    expect(dto.codigo).toBe('BCD23FGH');
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza un código con caracteres que el alfabeto no usa', async () => {
    // La O y el 0 no están en el alfabeto justamente para no confundirlos.
    expect(await invalidProps({ ...valid, codigo: 'BCD2O0GH' })).toContain(
      'codigo',
    );
  });

  it('rechaza un código de largo distinto', async () => {
    expect(await invalidProps({ ...valid, codigo: 'BCD23FG' })).toContain(
      'codigo',
    );
    expect(await invalidProps({ ...valid, codigo: 'BCD23FGHJ' })).toContain(
      'codigo',
    );
  });

  it('exige el nombre de quien consulta', async () => {
    expect(await invalidProps({ codigo: valid.codigo })).toContain('nombre');
    expect(await invalidProps({ ...valid, nombre: '   ' })).toContain('nombre');
  });

  it('recorta el nombre y la matrícula', () => {
    const dto = instancia({
      ...valid,
      nombre: '  Dra. Paula Ferrer  ',
      matricula: '  MP 12345  ',
    });

    expect(dto.nombre).toBe('Dra. Paula Ferrer');
    expect(dto.matricula).toBe('MP 12345');
  });

  it('la matrícula es opcional', async () => {
    expect(await invalidProps(valid)).toHaveLength(0);
  });

  it('rechaza una matrícula desproporcionada', async () => {
    expect(
      await invalidProps({ ...valid, matricula: 'M'.repeat(31) }),
    ).toContain('matricula');
  });
});
