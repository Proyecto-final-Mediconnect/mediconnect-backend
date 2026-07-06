import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { LoginDto } from './dto/login.dto';

describe('AuthService', () => {
  let service: AuthService;
  let signUp: jest.Mock;
  let signInWithPassword: jest.Mock;

  const dto: RegisterPatientDto = {
    email: 'nuevo@test.com',
    password: 'Password1',
    passwordConfirmation: 'Password1',
  };
  const loginDto: LoginDto = { email: 'user@test.com', password: 'Password1' };

  beforeEach(() => {
    signUp = jest.fn();
    signInWithPassword = jest.fn();
    const supabaseMock = {
      getClient: () => ({ auth: { signUp, signInWithPassword } }),
    } as unknown as SupabaseService;
    service = new AuthService(supabaseMock);
  });

  it('registra un usuario nuevo y devuelve el mensaje genérico', async () => {
    signUp.mockResolvedValue({
      data: { user: { identities: [{ id: 'abc' }] } },
      error: null,
    });

    const result = await service.registerPatient(dto);

    expect(signUp).toHaveBeenCalledWith({
      email: dto.email,
      password: dto.password,
    });
    expect(result.message).toContain('Revisá tu email');
  });

  it('devuelve el MISMO mensaje si el email ya existe (identities vacío, sin filtrar info)', async () => {
    signUp.mockResolvedValue({
      data: { user: { identities: [] } },
      error: null,
    });

    const result = await service.registerPatient(dto);

    expect(result.message).toContain('Revisá tu email');
  });

  it('lanza ServiceUnavailable ante rate limit (429)', async () => {
    signUp.mockResolvedValue({
      data: {},
      error: { status: 429, message: 'email rate limit exceeded' },
    });

    await expect(service.registerPatient(dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('lanza BadRequest ante otros errores de Supabase', async () => {
    signUp.mockResolvedValue({
      data: {},
      error: { status: 422, message: 'signup disabled' },
    });

    await expect(service.registerPatient(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('login exitoso devuelve tokens y datos del usuario', async () => {
    signInWithPassword.mockResolvedValue({
      data: {
        session: { access_token: 'acc', refresh_token: 'ref' },
        user: { id: 'uid', email: loginDto.email },
      },
      error: null,
    });

    const result = await service.login(loginDto);

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: loginDto.email,
      password: loginDto.password,
    });
    expect(result).toEqual({
      accessToken: 'acc',
      refreshToken: 'ref',
      user: { id: 'uid', email: loginDto.email },
    });
  });

  it('login con credenciales inválidas lanza Unauthorized (mensaje genérico)', async () => {
    signInWithPassword.mockResolvedValue({
      data: {},
      error: { code: 'invalid_credentials', status: 400, message: 'invalid' },
    });

    await expect(service.login(loginDto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('login con email sin confirmar lanza Unauthorized genérico (anti-enumeration)', async () => {
    signInWithPassword.mockResolvedValue({
      data: {},
      error: {
        code: 'email_not_confirmed',
        status: 400,
        message: 'Email not confirmed',
      },
    });

    await expect(service.login(loginDto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('login con rate limit lanza ServiceUnavailable', async () => {
    signInWithPassword.mockResolvedValue({
      data: {},
      error: { status: 429, message: 'rate limit' },
    });

    await expect(service.login(loginDto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
