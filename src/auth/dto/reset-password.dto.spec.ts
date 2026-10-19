import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ResetPasswordDto } from './reset-password.dto';

async function invalidProps(obj: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(ResetPasswordDto, obj);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

describe('ResetPasswordDto', () => {
  const valid = {
    tokenHash: 'abc123',
    password: 'Password1',
    passwordConfirmation: 'Password1',
  };

  it('acepta datos válidos', async () => {
    expect(await invalidProps(valid)).toHaveLength(0);
  });

  it('rechaza un tokenHash de más de 256 caracteres', async () => {
    expect(
      await invalidProps({ ...valid, tokenHash: 'a'.repeat(257) }),
    ).toContain('tokenHash');
  });

  it('acepta un tokenHash de exactamente 256 caracteres', async () => {
    expect(
      await invalidProps({ ...valid, tokenHash: 'a'.repeat(256) }),
    ).toHaveLength(0);
  });
});
