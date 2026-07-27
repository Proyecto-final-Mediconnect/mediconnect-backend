import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdatePatientProfileDto } from './update-patient-profile.dto';

async function invalidProps(obj: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(UpdatePatientProfileDto, obj);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

function transform(obj: Record<string, unknown>): UpdatePatientProfileDto {
  return plainToInstance(UpdatePatientProfileDto, obj);
}

describe('UpdatePatientProfileDto', () => {
  const valid = {
    firstName: 'Ana',
    lastName: 'Paciente',
    birthDate: '1990-05-20',
    dni: '12345678',
    phone: '+54 11 5555-5555',
  };

  it('acepta datos válidos', async () => {
    expect(await invalidProps(valid)).toHaveLength(0);
  });

  it('exige nombre y apellido', async () => {
    const props = await invalidProps({
      ...valid,
      firstName: '',
      lastName: '   ',
    });
    expect(props).toContain('firstName');
    expect(props).toContain('lastName');
  });

  describe('DNI argentino', () => {
    it('acepta 7 dígitos', async () => {
      expect(await invalidProps({ ...valid, dni: '1234567' })).not.toContain(
        'dni',
      );
    });

    it('normaliza los puntos y conserva solo los dígitos', () => {
      expect(transform({ ...valid, dni: '12.345.678' }).dni).toBe('12345678');
    });

    it('rechaza DNI con letras', async () => {
      expect(await invalidProps({ ...valid, dni: 'AB123456' })).toContain(
        'dni',
      );
    });

    it('rechaza DNI demasiado corto o largo', async () => {
      expect(await invalidProps({ ...valid, dni: '123' })).toContain('dni');
      expect(await invalidProps({ ...valid, dni: '123456789' })).toContain(
        'dni',
      );
    });
  });

  describe('fecha de nacimiento', () => {
    it('rechaza un formato no ISO', async () => {
      expect(
        await invalidProps({ ...valid, birthDate: '20/05/1990' }),
      ).toContain('birthDate');
    });
  });

  describe('teléfono', () => {
    it('rechaza caracteres no telefónicos', async () => {
      expect(await invalidProps({ ...valid, phone: '11-abc-99' })).toContain(
        'phone',
      );
    });
  });

  it('normaliza espacios sobrantes en el nombre', () => {
    expect(transform({ ...valid, firstName: '  Ana   María ' }).firstName).toBe(
      'Ana María',
    );
  });
});
