import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterPatientDto } from './register-patient.dto';

async function invalidProps(obj: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(RegisterPatientDto, obj);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

describe('RegisterPatientDto', () => {
  const valid = {
    email: 'user@test.com',
    password: 'Password1',
    passwordConfirmation: 'Password1',
  };

  it('acepta datos válidos', async () => {
    expect(await invalidProps(valid)).toHaveLength(0);
  });

  it('rechaza email con formato inválido', async () => {
    expect(await invalidProps({ ...valid, email: 'no-es-email' })).toContain(
      'email',
    );
  });

  it('rechaza contraseña de menos de 8 caracteres', async () => {
    expect(
      await invalidProps({
        ...valid,
        password: 'Ab1',
        passwordConfirmation: 'Ab1',
      }),
    ).toContain('password');
  });

  it('rechaza contraseña sin mayúscula', async () => {
    expect(
      await invalidProps({
        ...valid,
        password: 'password1',
        passwordConfirmation: 'password1',
      }),
    ).toContain('password');
  });

  it('rechaza contraseña sin número', async () => {
    expect(
      await invalidProps({
        ...valid,
        password: 'Passwordd',
        passwordConfirmation: 'Passwordd',
      }),
    ).toContain('password');
  });

  it('rechaza confirmación que no coincide', async () => {
    expect(
      await invalidProps({ ...valid, passwordConfirmation: 'Password2' }),
    ).toContain('passwordConfirmation');
  });
});
