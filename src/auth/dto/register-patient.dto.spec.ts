import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterPatientDto } from './register-patient.dto';
import { LEGAL_VERSION } from '../../legal/legal';

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
    acceptedLegalVersion: LEGAL_VERSION,
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

  it('rechaza el registro sin aceptar los textos legales (ENG-140)', async () => {
    const sinAceptar: Record<string, unknown> = { ...valid };
    delete sinAceptar.acceptedLegalVersion;
    expect(await invalidProps(sinAceptar)).toContain('acceptedLegalVersion');
  });

  it('rechaza una versión de los textos que no es la vigente', async () => {
    expect(
      await invalidProps({ ...valid, acceptedLegalVersion: '2020-01-01' }),
    ).toContain('acceptedLegalVersion');
  });
});
