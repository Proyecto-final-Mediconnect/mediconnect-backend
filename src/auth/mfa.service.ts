import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';

/** Lo que muestra la pantalla para escanear con la app autenticadora. */
export interface MfaEnrollment {
  factorId: string;
  /** El QR como imagen SVG (`data:image/svg+xml;...`), listo para un `<img>`. */
  qr: string;
  /** La clave para cargarla a mano si no se puede escanear. */
  secret: string;
}

/** Una sesión nueva, con el nivel de verificación más alto (`aal2`). */
export interface MfaSession {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email?: string };
}

interface GoTrueFactor {
  id: string;
  factor_type: string;
  status: 'verified' | 'unverified';
}

interface GoTrueSession {
  access_token: string;
  refresh_token: string;
  user: { id: string; email?: string };
}

/** Cuánto se espera a Supabase Auth. */
const TIMEOUT_MS = 10_000;

/** Con este nombre aparece la cuenta en la app autenticadora. */
const ISSUER = 'MediConnect';

const CODIGO_INVALIDO =
  'El código no es válido o ya venció. Probá con el que muestra ahora la app.';

/**
 * Verificación en dos pasos con TOTP (ENG-88): un código de seis dígitos que
 * cambia cada 30 segundos en una app autenticadora (Google Authenticator,
 * Authy, 1Password).
 *
 * La resuelve Supabase Auth (MFA de GoTrue) y este servicio habla con su API
 * REST con el token de la persona. No se usa `supabase-js` porque sus métodos
 * de MFA necesitan una sesión guardada en el cliente, y acá la sesión vive en
 * cookies httpOnly (web) o en el teléfono (app).
 *
 * Cómo se sabe que alguien la tiene activa: Supabase lo sabe por sus factores,
 * pero consultarlo en cada request sería una llamada de red. Se guarda además
 * en `profiles.mfa_enabled`, que `JwtAuthGuard` lee para no aceptar una sesión
 * sin el segundo paso (`aal1`) de quien lo activó.
 *
 * Es opcional y para los tres roles. No hay códigos de respaldo: si alguien
 * pierde el teléfono, un administrador borra el factor desde Supabase y pone
 * `mfa_enabled` en `false` (está en el runbook de seguridad).
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Si la persona tiene la verificación en dos pasos activa. */
  async isEnabled(accessToken: string): Promise<boolean> {
    return (await this.verifiedFactor(accessToken)) !== null;
  }

  /**
   * Empieza a activarla: crea un factor TOTP sin verificar y devuelve el QR.
   * Queda activa recién cuando se confirma con un código (`confirmEnrollment`).
   *
   * Un intento anterior que quedó a medias se borra antes: Supabase no deja dos
   * factores sin verificar, y el QR viejo ya no le sirve a nadie.
   */
  async startEnrollment(accessToken: string): Promise<MfaEnrollment> {
    const factors = await this.factors(accessToken);
    if (
      factors.some((f) => f.factor_type === 'totp' && f.status === 'verified')
    ) {
      throw new ConflictException(
        'Ya tenés activa la verificación en dos pasos.',
      );
    }
    for (const f of factors.filter((x) => x.status === 'unverified')) {
      await this.request('DELETE', `/factors/${f.id}`, accessToken);
    }

    const res = await this.request<{
      id: string;
      totp: { qr_code: string; secret: string };
    }>('POST', '/factors', accessToken, {
      factor_type: 'totp',
      issuer: ISSUER,
      // Único por intento: Supabase rechaza dos factores con el mismo nombre.
      friendly_name: `${ISSUER} ${new Date().toISOString()}`,
    });
    return { factorId: res.id, qr: res.totp.qr_code, secret: res.totp.secret };
  }

  /**
   * Confirma la activación con el primer código. Devuelve la sesión nueva, ya
   * con el segundo paso hecho: la anterior era `aal1` y, con la verificación
   * activa, el backend dejaría de aceptarla.
   */
  async confirmEnrollment(
    userId: string,
    accessToken: string,
    factorId: string,
    code: string,
  ): Promise<MfaSession> {
    const session = await this.challengeAndVerify(accessToken, factorId, code);
    await this.prisma.profile.update({
      where: { id: userId },
      data: { mfa_enabled: true },
    });
    await this.audit(userId, 'MFA_ENABLED');
    return session;
  }

  /**
   * El segundo paso del ingreso: con el token del primer paso (`aal1`) y el
   * código de la app, devuelve la sesión completa.
   */
  async verifyLogin(accessToken: string, code: string): Promise<MfaSession> {
    const factor = await this.verifiedFactor(accessToken);
    if (!factor) {
      throw new BadRequestException(
        'Tu cuenta no tiene activa la verificación en dos pasos.',
      );
    }
    return this.challengeAndVerify(accessToken, factor.id, code);
  }

  /**
   * La desactiva. Pide un código igual, aunque la sesión ya tenga el segundo
   * paso: así una sesión abierta en una compu ajena no alcanza para sacarla.
   */
  async disable(
    userId: string,
    accessToken: string,
    code: string,
  ): Promise<void> {
    const factor = await this.verifiedFactor(accessToken);
    if (!factor) {
      throw new BadRequestException(
        'No tenés activa la verificación en dos pasos.',
      );
    }
    // Supabase exige una sesión `aal2` para borrar un factor verificado: se usa
    // la que devuelve el código recién verificado.
    const session = await this.challengeAndVerify(accessToken, factor.id, code);
    await this.request('DELETE', `/factors/${factor.id}`, session.accessToken);
    await this.prisma.profile.update({
      where: { id: userId },
      data: { mfa_enabled: false },
    });
    await this.audit(userId, 'MFA_DISABLED');
  }

  /** El factor TOTP verificado de la persona, o `null`. */
  async verifiedFactor(accessToken: string): Promise<GoTrueFactor | null> {
    const factors = await this.factors(accessToken);
    return (
      factors.find(
        (f) => f.factor_type === 'totp' && f.status === 'verified',
      ) ?? null
    );
  }

  private async factors(accessToken: string): Promise<GoTrueFactor[]> {
    const user = await this.request<{ factors?: GoTrueFactor[] | null }>(
      'GET',
      '/user',
      accessToken,
    );
    return user.factors ?? [];
  }

  private async challengeAndVerify(
    accessToken: string,
    factorId: string,
    code: string,
  ): Promise<MfaSession> {
    const challenge = await this.request<{ id: string }>(
      'POST',
      `/factors/${encodeURIComponent(factorId)}/challenge`,
      accessToken,
    );
    const session = await this.request<GoTrueSession>(
      'POST',
      `/factors/${encodeURIComponent(factorId)}/verify`,
      accessToken,
      { challenge_id: challenge.id, code },
      // Un código equivocado es un 422 de GoTrue: se explica, no es un error del servidor.
      CODIGO_INVALIDO,
    );
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      user: { id: session.user.id, email: session.user.email },
    };
  }

  private async audit(userId: string, action: string): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actor_id: userId,
        action,
        resource_type: 'profiles',
        resource_id: userId,
      },
    });
  }

  /**
   * Llamada a la API de Supabase Auth con el token de la persona.
   *
   * - 401/403: la sesión no sirve (vencida o de otro usuario) → 401.
   * - 400/422: casi siempre un código equivocado → 400 con `rejectMessage`.
   * - 429: demasiados intentos → 503, como en el login.
   * - Sin respuesta o 5xx → 503: una caída no es un código mal puesto.
   */
  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    accessToken: string,
    body?: unknown,
    rejectMessage = 'No pudimos completar la verificación en dos pasos.',
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.supabase.getIssuer()}${path}`, {
        method,
        headers: {
          apikey: this.config.getOrThrow<string>('SUPABASE_ANON_KEY'),
          Authorization: `Bearer ${accessToken}`,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      this.logger.error(
        `Supabase Auth ${method} ${path} falló: ${String(cause)}`,
      );
      throw new ServiceUnavailableException(
        'No pudimos comunicarnos con el servicio de ingreso. Probá de nuevo en unos minutos.',
      );
    }

    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    if (res.status === 401 || res.status === 403) {
      throw new UnauthorizedException('Tu sesión venció. Ingresá de nuevo.');
    }
    if (res.status === 400 || res.status === 422) {
      throw new BadRequestException(rejectMessage);
    }
    if (res.status === 429) {
      throw new ServiceUnavailableException(
        'Demasiados intentos. Probá de nuevo en unos minutos.',
      );
    }
    this.logger.error(`Supabase Auth ${method} ${path} devolvió ${res.status}`);
    throw new ServiceUnavailableException(
      'No pudimos completar la verificación en dos pasos. Probá de nuevo en unos minutos.',
    );
  }
}
