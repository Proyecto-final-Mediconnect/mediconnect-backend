import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterProfessionalDto } from './register-professional.dto';

async function invalidProps(obj: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(RegisterProfessionalDto, obj);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

describe('RegisterProfessionalDto', () => {
  const valid = {
    email: 'pro@test.com',
    password: 'Password1',
    passwordConfirmation: 'Password1',
    firstName: 'Ana',
    lastName: 'García',
    specialty: 'Cardiología',
    licenseNumber: 'MP-12345',
  };

  it('acepta datos válidos', async () => {
    expect(await invalidProps(valid)).toHaveLength(0);
  });

  it('rechaza email con formato inválido', async () => {
    expect(await invalidProps({ ...valid, email: 'no-es-email' })).toContain(
      'email',
    );
  });

  it('rechaza contraseña débil', async () => {
    expect(
      await invalidProps({
        ...valid,
        password: 'password',
        passwordConfirmation: 'password',
      }),
    ).toContain('password');
  });

  it('rechaza confirmación que no coincide', async () => {
    expect(
      await invalidProps({ ...valid, passwordConfirmation: 'Password2' }),
    ).toContain('passwordConfirmation');
  });

  it('rechaza nombre vacío', async () => {
    expect(await invalidProps({ ...valid, firstName: '' })).toContain(
      'firstName',
    );
  });

  it('rechaza apellido vacío', async () => {
    expect(await invalidProps({ ...valid, lastName: 'A' })).toContain(
      'lastName',
    );
  });

  it('rechaza especialidad vacía', async () => {
    expect(await invalidProps({ ...valid, specialty: '' })).toContain(
      'specialty',
    );
  });

  it('rechaza matrícula con formato inválido', async () => {
    expect(await invalidProps({ ...valid, licenseNumber: 'ab' })).toContain(
      'licenseNumber',
    );
  });
});
