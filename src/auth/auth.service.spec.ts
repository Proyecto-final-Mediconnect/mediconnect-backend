import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { RegisterProfessionalDto } from './dto/register-professional.dto';
import { LoginDto } from './dto/login.dto';
import { LEGAL_VERSION } from '../legal/legal';
import { LegalEnforcement } from '../legal/legal-enforcement';
import { PrismaService } from '../prisma/prisma.service';
import * as Sentry from '@sentry/nestjs';

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));

describe('AuthService', () => {
  let service: AuthService;
  let signUp: jest.Mock;
  let signInWithPassword: jest.Mock;
  /** Estado del flag de ENG-140 para cada caso; se resetea en `beforeEach`. */
  let legalEnforcementEnabled = false;

  const dto: RegisterPatientDto = {
    email: 'nuevo@test.com',
    password: 'Password1',
    passwordConfirmation: 'Password1',
    acceptedLegalVersion: LEGAL_VERSION,
  };
  const proDto: RegisterProfessionalDto = {
    email: 'pro@test.com',
    password: 'Password1',
    passwordConfirmation: 'Password1',
    firstName: 'Ana',
    lastName: 'García',
    specialty: 'Cardiología',
    licenseNumber: 'MP-12345',
    acceptedLegalVersion: LEGAL_VERSION,
  };
  /** Lo que manda una web anterior a ENG-140: sin el campo de la aceptación. */
  const dtoSinAceptacion: RegisterPatientDto = {
    email: dto.email,
    password: dto.password,
    passwordConfirmation: dto.passwordConfirmation,
  };
  const ctx = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (test)' };
  const loginDto: LoginDto = { email: 'user@test.com', password: 'Password1' };

  let refreshSession: jest.Mock;
  let createMany: jest.Mock;
  let resetPasswordForEmail: jest.Mock;
  let verifyOtp: jest.Mock;
  let updateUser: jest.Mock;
  let signOut: jest.Mock;
  let createSessionClient: jest.Mock;

  beforeEach(() => {
    signUp = jest.fn();
    signInWithPassword = jest.fn();
    refreshSession = jest.fn();
    createMany = jest.fn().mockResolvedValue({ count: 1 });
    resetPasswordForEmail = jest.fn();
    verifyOtp = jest.fn();
    updateUser = jest.fn();
    signOut = jest.fn().mockResolvedValue({ error: null });
    createSessionClient = jest.fn(() => ({
      auth: { verifyOtp, updateUser, signOut },
    }));
    const supabaseMock = {
      getClient: () => ({
        auth: {
          signUp,
          signInWithPassword,
          refreshSession,
          resetPasswordForEmail,
        },
      }),
      createSessionClient,
    } as unknown as SupabaseService;
    const prismaMock = {
      legalAcceptance: { createMany },
    } as unknown as PrismaService;
    legalEnforcementEnabled = false;
    const enforcementMock = {
      isEnabled: () => legalEnforcementEnabled,
    } as unknown as LegalEnforcement;
    service = new AuthService(supabaseMock, prismaMock, enforcementMock);
  });

  describe('aceptación legal (ENG-140)', () => {
    // Los tres casos del despliegue escalonado: ver `LegalEnforcement`.
    it('con la aplicación prendida rechaza el registro sin la aceptación', async () => {
      legalEnforcementEnabled = true;

      await expect(
        service.registerPatient(dtoSinAceptacion, ctx),
      ).rejects.toThrow(BadRequestException);
      // Antes del signUp: si no, la cuenta queda creada en Supabase y el
      // usuario no puede reintentar con el mismo email.
      expect(signUp).not.toHaveBeenCalled();
      expect(createMany).not.toHaveBeenCalled();
    });

    it('con la aplicación apagada deja registrar sin la aceptación', async () => {
      // Es el caso de la web vieja contra este backend ya desplegado.
      legalEnforcementEnabled = false;
      signUp.mockResolvedValue({
        data: { user: { id: 'nuevo-id', identities: [{ id: 'abc' }] } },
        error: null,
      });

      await expect(
        service.registerPatient(dtoSinAceptacion, ctx),
      ).resolves.toEqual(
        expect.objectContaining({ message: expect.any(String) }),
      );
      expect(signUp).toHaveBeenCalled();
      // No se inventa una fila: nadie aceptó nada.
      expect(createMany).not.toHaveBeenCalled();
    });

    it('con la aplicación prendida y la aceptación presente, registra normal', async () => {
      legalEnforcementEnabled = true;
      signUp.mockResolvedValue({
        data: { user: { id: 'nuevo-id', identities: [{ id: 'abc' }] } },
        error: null,
      });

      await service.registerPatient(dto, ctx);

      expect(createMany).toHaveBeenCalled();
    });

    it('deja constancia de la versión vigente para el usuario nuevo', async () => {
      signUp.mockResolvedValue({
        data: { user: { id: 'nuevo-id', identities: [{ id: 'abc' }] } },
        error: null,
      });

      await service.registerPatient(dto, ctx);

      expect(createMany).toHaveBeenCalledWith({
        data: [
          {
            profile_id: 'nuevo-id',
            version: LEGAL_VERSION,
            source: 'REGISTER',
            ip: '203.0.113.7',
            user_agent: 'Mozilla/5.0 (test)',
          },
        ],
        skipDuplicates: true,
      });
    });

    it('también al registrar un profesional', async () => {
      signUp.mockResolvedValue({
        data: { user: { id: 'pro-id', identities: [{ id: 'abc' }] } },
        error: null,
      });

      await service.registerProfessional(proDto, ctx);

      expect(createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              profile_id: 'pro-id',
              version: LEGAL_VERSION,
              source: 'REGISTER',
            }),
          ],
        }),
      );
    });

    it('no registra nada si el email ya existía', async () => {
      // El user ofuscado de Supabase no es el del dueño de la cuenta: anotarle
      // una aceptación sería atribuírsela a otra persona.
      signUp.mockResolvedValue({
        data: { user: { id: 'ofuscado', identities: [] } },
        error: null,
      });

      await service.registerPatient(dto, ctx);

      expect(createMany).not.toHaveBeenCalled();
    });

    it('si no se puede guardar, el registro responde igual', async () => {
      // La cuenta ya existe en Supabase: un error acá haría que el usuario
      // reintente contra un email tomado. La web le vuelve a pedir la
      // aceptación al entrar.
      signUp.mockResolvedValue({
        data: { user: { id: 'nuevo-id', identities: [{ id: 'abc' }] } },
        error: null,
      });
      const error = new Error('base caída');
      createMany.mockRejectedValue(error);
      (Sentry.captureException as jest.Mock).mockClear();

      await expect(service.registerPatient(dto, ctx)).resolves.toMatchObject({
        message: expect.stringContaining('Revisá tu email'),
      });
      // Pero no en silencio: es un consentimiento que no quedó guardado.
      expect(Sentry.captureException).toHaveBeenCalledWith(error, {
        tags: { feature: 'eng140', operation: 'record_legal_acceptance' },
      });
    });
  });

  it('registra un usuario nuevo y devuelve el mensaje genérico', async () => {
    signUp.mockResolvedValue({
      data: { user: { identities: [{ id: 'abc' }] } },
      error: null,
    });

    const result = await service.registerPatient(dto, ctx);

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

    const result = await service.registerPatient(dto, ctx);

    expect(result.message).toContain('Revisá tu email');
  });

  it('lanza ServiceUnavailable ante rate limit (429)', async () => {
    signUp.mockResolvedValue({
      data: {},
      error: { status: 429, message: 'email rate limit exceeded' },
    });

    await expect(service.registerPatient(dto, ctx)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('lanza BadRequest ante otros errores de Supabase', async () => {
    signUp.mockResolvedValue({
      data: {},
      error: { status: 422, message: 'signup disabled' },
    });

    await expect(service.registerPatient(dto, ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('ante fallo de red (sin status) lanza ServiceUnavailable, sin filtrar el detalle crudo', async () => {
    signUp.mockResolvedValue({
      data: {},
      error: { message: 'fetch failed' },
    });

    await expect(service.registerPatient(dto, ctx)).rejects.toMatchObject({
      constructor: ServiceUnavailableException,
      message: expect.not.stringContaining('fetch failed'),
    });
  });

  it('registra un profesional enviando role y datos en options.data', async () => {
    signUp.mockResolvedValue({
      data: { user: { identities: [{ id: 'abc' }] } },
      error: null,
    });

    const result = await service.registerProfessional(proDto, ctx);

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

    const result = await service.registerProfessional(proDto, ctx);

    expect(result.message).toContain('Revisá tu email');
  });

  it('registro profesional con rate limit lanza ServiceUnavailable', async () => {
    signUp.mockResolvedValue({
      data: {},
      error: { status: 429, message: 'email rate limit exceeded' },
    });

    await expect(
      service.registerProfessional(proDto, ctx),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('registro profesional con fallo de red lanza ServiceUnavailable sin filtrar el detalle crudo', async () => {
    signUp.mockResolvedValue({
      data: {},
      error: { message: 'fetch failed' },
    });

    await expect(
      service.registerProfessional(proDto, ctx),
    ).rejects.toMatchObject({
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

  describe('recuperar contraseña (ENG-142)', () => {
    const GENERIC =
      'Si hay una cuenta con ese email, te mandamos un enlace para elegir una contraseña nueva. Revisá tu correo.';
    const resetDto = {
      tokenHash: 'hash-del-mail',
      password: 'NuevaClave1',
      passwordConfirmation: 'NuevaClave1',
    };

    it('pide el mail con el enlace a /restablecer-contrasena de la web', async () => {
      resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });

      const result = await service.forgotPassword({ email: 'a@test.com' });

      expect(resetPasswordForEmail).toHaveBeenCalledWith('a@test.com', {
        redirectTo: 'http://localhost:5173/restablecer-contrasena',
      });
      expect(result).toEqual({ message: GENERIC });
    });

    it('responde lo mismo ante un error de Supabase, incluido el límite por usuario', async () => {
      resetPasswordForEmail.mockResolvedValue({
        data: null,
        error: { status: 429, message: 'only request this after 60 seconds' },
      });

      await expect(
        service.forgotPassword({ email: 'a@test.com' }),
      ).resolves.toEqual({ message: GENERIC });
    });

    it('si Supabase no responde (sin status) avisa con 503', async () => {
      resetPasswordForEmail.mockResolvedValue({
        data: null,
        error: { message: 'fetch failed' },
      });

      await expect(
        service.forgotPassword({ email: 'a@test.com' }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('canjea el token, cambia la contraseña y cierra todas las sesiones', async () => {
      verifyOtp.mockResolvedValue({
        data: { session: { access_token: 't' }, user: { id: 'u1' } },
        error: null,
      });
      updateUser.mockResolvedValue({ data: { user: {} }, error: null });

      const result = await service.resetPassword(resetDto);

      expect(verifyOtp).toHaveBeenCalledWith({
        token_hash: 'hash-del-mail',
        type: 'recovery',
      });
      expect(updateUser).toHaveBeenCalledWith({ password: 'NuevaClave1' });
      expect(signOut).toHaveBeenCalledWith({ scope: 'global' });
      expect(result.message).toMatch(/cambiaste tu contraseña/);
    });

    it('usa un cliente descartable por pedido, no el compartido', async () => {
      verifyOtp.mockResolvedValue({
        data: { session: { access_token: 't' }, user: { id: 'u1' } },
        error: null,
      });
      updateUser.mockResolvedValue({ data: { user: {} }, error: null });

      await service.resetPassword(resetDto);
      await service.resetPassword(resetDto);

      expect(createSessionClient).toHaveBeenCalledTimes(2);
    });

    it('con un enlace vencido o ya usado responde 400 y no toca la contraseña', async () => {
      verifyOtp.mockResolvedValue({
        data: { session: null, user: null },
        error: { status: 403, code: 'otp_expired', message: 'expired' },
      });

      await expect(service.resetPassword(resetDto)).rejects.toThrow(
        'El enlace para restablecer la contraseña no es válido o ya venció. Pedí uno nuevo.',
      );
      expect(updateUser).not.toHaveBeenCalled();
    });

    it('si Supabase no responde al canjear el token devuelve 503, no "enlace inválido"', async () => {
      verifyOtp.mockResolvedValue({
        data: { session: null, user: null },
        error: { message: 'fetch failed' },
      });

      await expect(service.resetPassword(resetDto)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('si Supabase responde 5xx al canjear el token devuelve 503, no "enlace inválido"', async () => {
      verifyOtp.mockResolvedValue({
        data: { session: null, user: null },
        error: { status: 502, message: 'bad gateway' },
      });

      await expect(service.resetPassword(resetDto)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(updateUser).not.toHaveBeenCalled();
    });

    describe('si falla el cambio de contraseña (el enlace ya se gastó)', () => {
      beforeEach(() => {
        verifyOtp.mockResolvedValue({
          data: { session: { access_token: 't' }, user: { id: 'u1' } },
          error: null,
        });
      });

      async function caught(): Promise<{
        status: number;
        body: { message: string; code: string };
      }> {
        try {
          await service.resetPassword(resetDto);
        } catch (e) {
          const ex = e as HttpException;
          return {
            status: ex.getStatus(),
            body: ex.getResponse() as { message: string; code: string },
          };
        }
        throw new Error('no lanzó');
      }

      it.each([
        ['same_password', /distinta de la anterior/],
        ['weak_password', /muy débil/],
        ['otro_error', /boom/],
      ])(
        '%s: avisa que pida otro enlace y trae el code estable',
        async (code, msg) => {
          updateUser.mockResolvedValue({
            data: { user: null },
            error: { status: 422, code, message: 'boom' },
          });

          const { status, body } = await caught();

          expect(status).toBe(400);
          expect(body.code).toBe('RECOVERY_LINK_CONSUMED');
          expect(body.message).toMatch(msg);
          expect(body.message).toMatch(/pedí uno nuevo/);
          expect(signOut).not.toHaveBeenCalled();
        },
      );

      it('si Supabase no responde al cambiar la contraseña: 503 con el mismo code', async () => {
        updateUser.mockResolvedValue({
          data: { user: null },
          error: { message: 'fetch failed' },
        });

        const { status, body } = await caught();

        expect(status).toBe(503);
        expect(body.code).toBe('RECOVERY_LINK_CONSUMED');
        expect(body.message).toMatch(/pedí uno nuevo/);
      });
    });

    it('si no se pueden cerrar las sesiones, la contraseña igual quedó cambiada', async () => {
      verifyOtp.mockResolvedValue({
        data: { session: { access_token: 't' }, user: { id: 'u1' } },
        error: null,
      });
      updateUser.mockResolvedValue({ data: { user: {} }, error: null });
      signOut.mockResolvedValue({ error: { status: 500, message: 'x' } });

      await expect(service.resetPassword(resetDto)).resolves.toEqual({
        message: expect.stringMatching(/cambiaste tu contraseña/) as string,
      });
    });
  });
});
