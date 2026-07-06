import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { LoginDto } from './dto/login.dto';
import { RegisterPatientDto } from './dto/register-patient.dto';

/** Respuesta genérica: idéntica exista o no la cuenta (no revela si el email
 *  ya está registrado — criterio de seguridad de ENG-42). */
const GENERIC_REGISTER_MESSAGE =
  'Registro iniciado. Revisá tu email para verificar tu cuenta.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async registerPatient(dto: RegisterPatientDto): Promise<{ message: string }> {
    const { data, error } = await this.supabase.getClient().auth.signUp({
      email: dto.email,
      password: dto.password,
    });

    if (error) {
      // Rate limit del plan Free u otros errores transitorios.
      if (error.status === 429) {
        throw new ServiceUnavailableException(
          'Demasiados intentos. Probá de nuevo en unos minutos.',
        );
      }
      throw new BadRequestException(error.message);
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
}
