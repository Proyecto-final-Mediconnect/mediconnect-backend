import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { RegisterProfessionalDto } from './dto/register-professional.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

/** Respuesta genérica: idéntica exista o no la cuenta (no revela si el email
 *  ya está registrado — criterio de seguridad de ENG-42). */
const GENERIC_REGISTER_MESSAGE =
  'Registro iniciado. Revisá tu email para verificar tu cuenta.';

/** Respuesta genérica al pedir el enlace de recuperación (ENG-142): la misma
 *  exista o no la cuenta, para no revelar qué emails están registrados. */
const GENERIC_FORGOT_PASSWORD_MESSAGE =
  'Si hay una cuenta con ese email, te mandamos un enlace para elegir una contraseña nueva. Revisá tu correo.';

const INVALID_RECOVERY_LINK_MESSAGE =
  'El enlace para restablecer la contraseña no es válido o ya venció. Pedí uno nuevo.';

/** `code` estable en el body de los errores que ocurren DESPUÉS de canjear el
 *  `token_hash` (ENG-142): el enlace ya se gastó, así que el front tiene que
 *  llevar al usuario a pedir uno nuevo en vez de dejarlo reintentar. */
export const RECOVERY_LINK_CONSUMED_CODE = 'RECOVERY_LINK_CONSUMED';

const NEW_LINK_HINT = 'Por seguridad, este enlace ya no sirve: pedí uno nuevo.';

/** Adónde lleva el enlace del mail de recuperación. El template de Supabase
 *  arma `{{ .RedirectTo }}?token_hash=…&type=recovery` sobre esta URL, que
 *  tiene que estar en las Redirect URLs del proyecto. */
function passwordResetRedirectUrl(): string {
  const webOrigin = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').replace(
    /\/+$/,
    '',
  );
  return `${webOrigin}/restablecer-contrasena`;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly supabase: SupabaseService) {}

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

  async registerPatient(dto: RegisterPatientDto): Promise<{ message: string }> {
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

    return { message: GENERIC_REGISTER_MESSAGE };
  }

  async registerProfessional(
    dto: RegisterProfessionalDto,
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

  /**
   * Manda el mail con el enlace para elegir una contraseña nueva (ENG-142).
   *
   * Responde siempre lo mismo, exista o no la cuenta. Supabase tampoco lo
   * revela, pero además tragamos sus errores "de negocio" —incluido el límite
   * de un mail por minuto por usuario—, porque un mensaje distinto delataría que
   * el email está registrado. Solo una caída de Supabase (sin `status`) se
   * informa: no dice nada sobre la cuenta y el usuario necesita saber que el
   * mail no salió.
   *
   * Decisión sobre el canal lateral de tiempo (con cuenta existente GoTrue
   * manda el mail dentro del request y tarda más): NO se dispara sin `await`.
   * Hacerlo implicaría perder el 503 cuando Supabase no responde, y el usuario
   * quedaría esperando un mail que nunca sale sin ningún aviso. El riesgo
   * residual es bajo: el throttle de 3/min por IP limita mucho la medición.
   * Si más adelante se quiere cerrar, la opción es igualar el tiempo de
   * respuesta (delay mínimo) sin dejar de esperar a Supabase.
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const { error } = await this.supabase
      .getClient()
      .auth.resetPasswordForEmail(dto.email, {
        redirectTo: passwordResetRedirectUrl(),
      });

    if (error) {
      if (!error.status) {
        throw new ServiceUnavailableException(
          'No pudimos conectar con el servicio. Probá de nuevo en unos minutos.',
        );
      }
      this.logger.warn(
        `No se pudo enviar el mail de recuperación (status ${error.status}): ${error.message}`,
      );
    }

    return { message: GENERIC_FORGOT_PASSWORD_MESSAGE };
  }

  /**
   * Cambia la contraseña con el `token_hash` del enlace del mail (ENG-142).
   *
   * 1. `verifyOtp` canjea el token —de un solo uso— por una sesión de
   *    recuperación. Es lo que prueba que quien pide el cambio controla el email.
   * 2. Con esa sesión se cambia la contraseña.
   * 3. Se cierran **todas** las sesiones del usuario (`scope: 'global'`): si
   *    alguien más había entrado a la cuenta, pierde el refresh token. Los
   *    access tokens ya emitidos siguen valiendo hasta que vencen (1 h).
   *
   * Usa un cliente descartable: la sesión de recuperación no puede quedar en el
   * cliente compartido.
   *
   * Ojo: tras el paso 1 el enlace ya está gastado. Cualquier error del paso 2
   * avisa que hay que pedir un enlace nuevo y trae `code:
   * RECOVERY_LINK_CONSUMED` en el body para que el front lo maneje.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const client = this.supabase.createSessionClient();

    const { data, error: verifyError } = await client.auth.verifyOtp({
      token_hash: dto.tokenHash,
      type: 'recovery',
    });

    if (verifyError || !data.session) {
      // Sin `status` (red caída), 429 o 5xx de Supabase: es un fallo de infra,
      // no un enlace inválido (mismo criterio que `refresh()`). 503 para que
      // el usuario reintente con el mismo enlace, que todavía no se gastó.
      if (
        verifyError &&
        (!verifyError.status ||
          verifyError.status === 429 ||
          verifyError.status >= 500)
      ) {
        if (verifyError.status && verifyError.status >= 500) {
          throw new ServiceUnavailableException(
            'No pudimos conectar con el servicio. Probá de nuevo en unos minutos.',
          );
        }
        this.throwAuthError(verifyError);
      }
      throw new BadRequestException(INVALID_RECOVERY_LINK_MESSAGE);
    }

    const { error: updateError } = await client.auth.updateUser({
      password: dto.password,
    });

    if (updateError) {
      // El enlace ya se consumió en `verifyOtp`: todos los errores de acá
      // llevan el `code` y el aviso de pedir un enlace nuevo.
      if (updateError.code === 'same_password') {
        throw new BadRequestException({
          message: `La contraseña nueva tiene que ser distinta de la anterior. ${NEW_LINK_HINT}`,
          code: RECOVERY_LINK_CONSUMED_CODE,
        });
      }
      if (updateError.code === 'weak_password') {
        throw new BadRequestException({
          message: `La contraseña es muy débil. ${NEW_LINK_HINT}`,
          code: RECOVERY_LINK_CONSUMED_CODE,
        });
      }
      if (!updateError.status || updateError.status >= 500) {
        throw new ServiceUnavailableException({
          message: `No pudimos cambiar la contraseña. ${NEW_LINK_HINT}`,
          code: RECOVERY_LINK_CONSUMED_CODE,
        });
      }
      throw new BadRequestException({
        message: `${updateError.message} ${NEW_LINK_HINT}`,
        code: RECOVERY_LINK_CONSUMED_CODE,
      });
    }

    const { error: signOutError } = await client.auth.signOut({
      scope: 'global',
    });
    if (signOutError) {
      // La contraseña ya cambió: no fallamos el pedido por esto.
      this.logger.warn(
        `No se pudieron cerrar las sesiones tras restablecer la contraseña: ${signOutError.message}`,
      );
    }

    return {
      message:
        'Listo, cambiaste tu contraseña. Ya podés ingresar con la nueva.',
    };
  }
}
