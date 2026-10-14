import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { LegalAcceptanceContext } from '../legal/acceptance-context';
import { LEGAL_VERSION } from '../legal/legal';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { LoginDto } from './dto/login.dto';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { RegisterProfessionalDto } from './dto/register-professional.dto';

/** Respuesta genérica: idéntica exista o no la cuenta (no revela si el email
 *  ya está registrado — criterio de seguridad de ENG-42). */
const GENERIC_REGISTER_MESSAGE =
  'Registro iniciado. Revisá tu email para verificar tu cuenta.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Deja constancia de que el usuario recién creado aceptó los textos legales
   * vigentes (ENG-140). El DTO ya exigió que `acceptedLegalVersion` sea la
   * vigente, así que acá se guarda `LEGAL_VERSION` y no lo que mandó el cliente.
   *
   * El perfil ya existe: lo crea el trigger `on_auth_user_created` dentro del
   * mismo `signUp`.
   *
   * Un fallo acá **no** falla el registro: la cuenta en Supabase ya está creada,
   * y responder error haría que el usuario lo intente de nuevo contra un email
   * que ya existe. Sin la fila, `GET /me` informa que no aceptó y la web se lo
   * vuelve a pedir antes de dejarlo usar la app (y `LegalAcceptedGuard` no lo
   * deja usar la API hasta que acepte).
   *
   * Que no se haya podido guardar un consentimiento es un evento de compliance:
   * además del log va a Sentry, para notar si empieza a fallar seguido.
   */
  private async recordLegalAcceptance(
    userId: string,
    context: LegalAcceptanceContext,
  ): Promise<void> {
    try {
      await this.prisma.legalAcceptance.createMany({
        data: [
          {
            profile_id: userId,
            version: LEGAL_VERSION,
            source: 'REGISTER',
            ip: context.ip,
            user_agent: context.userAgent,
          },
        ],
        skipDuplicates: true,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo registrar la aceptación legal de ${userId}: ${String(error)}`,
      );
      Sentry.captureException(error, {
        tags: { feature: 'eng140', operation: 'record_legal_acceptance' },
      });
    }
  }

  /** Traduce un error de Supabase Auth (signUp/signIn) a una excepción HTTP con
   *  mensaje amigable, sin filtrar detalles crudos como "fetch failed". */
  private throwAuthError(error: { status?: number; message: string }): never {
    // Rate limit del plan Free.
    if (error.status === 429) {
      throw new ServiceUnavailableException(
        'Demasiados intentos. Probá de nuevo en unos minutos.',
      );
    }
    // Sin `status` = fallo de red / Supabase inalcanzable (ej. error.message
    // "fetch failed"). No lo mostramos crudo: mensaje amigable y 503.
    if (!error.status) {
      throw new ServiceUnavailableException(
        'No pudimos conectar con el servicio. Probá de nuevo en unos minutos.',
      );
    }
    throw new BadRequestException(error.message);
  }

  async registerPatient(
    dto: RegisterPatientDto,
    context: LegalAcceptanceContext,
  ): Promise<{ message: string }> {
    const { data, error } = await this.supabase.getClient().auth.signUp({
      email: dto.email,
      password: dto.password,
    });

    if (error) {
      this.throwAuthError(error);
    }

    // Con "Confirm email" activo, si el email ya existe y está confirmado,
    // Supabase devuelve un user ofuscado con identities vacío. Respondemos el
    // mismo mensaje genérico para no revelar que la cuenta existe.
    if (data.user && data.user.identities?.length === 0) {
      this.logger.debug('Registro con email ya existente (respuesta genérica)');
      return { message: GENERIC_REGISTER_MESSAGE };
    }

    if (data.user) await this.recordLegalAcceptance(data.user.id, context);

    return { message: GENERIC_REGISTER_MESSAGE };
  }

  async registerProfessional(
    dto: RegisterProfessionalDto,
    context: LegalAcceptanceContext,
  ): Promise<{ message: string }> {
    // Los datos profesionales viajan en raw_user_meta_data (options.data). El
    // trigger on_auth_user_created los consume para crear el perfil con
    // role=PROFESIONAL y la fila en `professionals` con estado
    // PENDIENTE_VALIDACION_MATRICULA (validación de matrícula manual en el MVP).
    const { data, error } = await this.supabase.getClient().auth.signUp({
      email: dto.email,
      password: dto.password,
      options: {
        data: {
          role: 'PROFESIONAL',
          first_name: dto.firstName,
          last_name: dto.lastName,
          specialty: dto.specialty,
          license_number: dto.licenseNumber,
        },
      },
    });

    if (error) {
      this.throwAuthError(error);
    }

    // Mismo criterio anti-enumeration que el registro de paciente: si el email
    // ya existe (identities vacío), respondemos idéntico sin revelarlo.
    if (data.user && data.user.identities?.length === 0) {
      this.logger.debug('Registro con email ya existente (respuesta genérica)');
      return { message: GENERIC_REGISTER_MESSAGE };
    }

    if (data.user) await this.recordLegalAcceptance(data.user.id, context);

    return { message: GENERIC_REGISTER_MESSAGE };
  }

  async login(dto: LoginDto) {
    const { data, error } = await this.supabase
      .getClient()
      .auth.signInWithPassword({ email: dto.email, password: dto.password });

    if (error) {
      if (error.status === 429) {
        throw new ServiceUnavailableException(
          'Demasiados intentos. Probá de nuevo en unos minutos.',
        );
      }
      // Credenciales inválidas O email sin confirmar → MISMO mensaje genérico,
      // para no revelar si la cuenta existe (anti email-enumeration). La guía
      // de "revisá tu correo" ya vive en la pantalla de registro.
      throw new UnauthorizedException('Email o contraseña incorrectos.');
    }

    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: { id: data.user.id, email: data.user.email },
    };
  }

  async refresh(refreshToken: string) {
    const { data, error } = await this.supabase
      .getClient()
      .auth.refreshSession({ refresh_token: refreshToken });

    if (error || !data.session || !data.user) {
      if (error?.status === 429) {
        throw new ServiceUnavailableException(
          'Demasiados intentos. Probá de nuevo en unos minutos.',
        );
      }
      // Fallo de infra (Supabase inalcanzable = sin `status`, o 5xx
      // transitorio): NO es un token inválido. Devolvemos 503 para que el
      // controller NO limpie las cookies — deslogear al usuario por una caída
      // temporal de Supabase sería un falso negativo (mismo criterio que
      // JwtAuthGuard). Solo un error real del token (400) desloguea.
      if (error && (!error.status || error.status >= 500)) {
        throw new ServiceUnavailableException(
          'No pudimos renovar tu sesión. Probá de nuevo en unos minutos.',
        );
      }
      // Refresh token inválido, vencido o ya usado (Supabase rota el refresh
      // token en cada uso: uno viejo reusado cae acá). No hay nada que
      // reintentar del lado del cliente salvo loguearse de nuevo.
      throw new UnauthorizedException(
        'Sesión inválida. Iniciá sesión de nuevo.',
      );
    }

    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: { id: data.user.id, email: data.user.email },
    };
  }
}
