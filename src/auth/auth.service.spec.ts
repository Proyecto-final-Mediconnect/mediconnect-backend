import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { RegisterProfessionalDto } from './dto/register-professional.dto';
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
  const proDto: RegisterProfessionalDto = {
    email: 'pro@test.com',
    password: 'Password1',
    passwordConfirmation: 'Password1',
    firstName: 'Ana',
    lastName: 'García',
    specialty: 'Cardiología',
    licenseNumber: 'MP-12345',
  };
  const loginDto: LoginDto = { email: 'user@test.com', password: 'Password1' };

  let refreshSession: jest.Mock;

  beforeEach(() => {
    signUp = jest.fn();
    signInWithPassword = jest.fn();
    refreshSession = jest.fn();
    const supabaseMock = {
      getClient: () => ({
        auth: { signUp, signInWithPassword, refreshSession },
      }),
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

  it('ante fallo de red (sin status) lanza ServiceUnavailable, sin filtrar el detalle crudo', async () => {
    signUp.mockResolvedValue({
      data: {},
      error: { message: 'fetch failed' },
    });

    await expect(service.registerPatient(dto)).rejects.toMatchObject({
      constructor: ServiceUnavailableException,
      message: expect.not.stringContaining('fetch failed'),
    });
  });

  it('registra un profesional enviando role y datos en options.data', async () => {
    signUp.mockResolvedValue({
      data: { user: { identities: [{ id: 'abc' }] } },
      error: null,
    });

    const result = await service.registerProfessional(proDto);

    expect(signUp).toHaveBeenCalledWith({
      email: proDto.email,
      password: proDto.password,
      options: {
        data: {
          role: 'PROFESIONAL',
          first_name: proDto.firstName,
          last_name: proDto.lastName,
          specialty: proDto.specialty,
          license_number: proDto.licenseNumber,
        },
      },
    });
    expect(result.message).toContain('Revisá tu email');
  });

  it('registro profesional con email ya existente devuelve el MISMO mensaje', async () => {
    signUp.mockResolvedValue({
      data: { user: { identities: [] } },
      error: null,
    });

    const result = await service.registerProfessional(proDto);

    expect(result.message).toContain('Revisá tu email');
  });

  it('registro profesional con rate limit lanza ServiceUnavailable', async () => {
    signUp.mockResolvedValue({
      data: {},
      error: { status: 429, message: 'email rate limit exceeded' },
    });

    await expect(service.registerProfessional(proDto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('registro profesional con fallo de red lanza ServiceUnavailable sin filtrar el detalle crudo', async () => {
    signUp.mockResolvedValue({
      data: {},
      error: { message: 'fetch failed' },
    });

    await expect(service.registerProfessional(proDto)).rejects.toMatchObject({
      constructor: ServiceUnavailableException,
      message: expect.not.stringContaining('fetch failed'),
    });
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

  it('refresh exitoso devuelve el par de tokens ROTADO y los datos del usuario', async () => {
    refreshSession.mockResolvedValue({
      data: {
        session: { access_token: 'new-acc', refresh_token: 'new-ref' },
        user: { id: 'uid', email: loginDto.email },
      },
      error: null,
    });

    const result = await service.refresh('old-ref');

    expect(refreshSession).toHaveBeenCalledWith({ refresh_token: 'old-ref' });
    expect(result).toEqual({
      accessToken: 'new-acc',
      refreshToken: 'new-ref',
      user: { id: 'uid', email: loginDto.email },
    });
  });

  it('refresh con token inválido/vencido/ya usado lanza Unauthorized', async () => {
    refreshSession.mockResolvedValue({
      data: {},
      error: { status: 400, message: 'Invalid Refresh Token' },
    });

    await expect(service.refresh('token-viejo')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refresh con rate limit lanza ServiceUnavailable', async () => {
    refreshSession.mockResolvedValue({
      data: {},
      error: { status: 429, message: 'rate limit' },
    });

    await expect(service.refresh('ref')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('refresh con Supabase caído (sin status) lanza ServiceUnavailable, no Unauthorized', async () => {
    refreshSession.mockResolvedValue({
      data: {},
      error: { message: 'fetch failed' },
    });

    await expect(service.refresh('ref')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('refresh con error 5xx de Supabase lanza ServiceUnavailable, no Unauthorized', async () => {
    refreshSession.mockResolvedValue({
      data: {},
      error: { status: 500, message: 'internal error' },
    });

    await expect(service.refresh('ref')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
