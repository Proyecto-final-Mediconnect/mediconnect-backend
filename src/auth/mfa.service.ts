import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { clientIp } from '../common/http/client-ip';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { invalidateMfaCache } from './guards/mfa-status-cache';

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

/** Desde dónde se hizo cada operación, para la auditoría. */
export interface MfaAuditContext {
  /** IP real del cliente (ENG-84); `null` si no se pudo determinar. */
  ip: string | null;
  userAgent: string | null;
}

/** Mismo largo que `legal_acceptances.user_agent`. */
const USER_AGENT_MAX_LENGTH = 512;

export function mfaAuditContext(req: Request): MfaAuditContext {
  const userAgent = req.headers['user-agent'];
  return {
    ip: clientIp(req),
    userAgent: userAgent ? userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null,
  };
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

/** Lo que se guarda en `audit_logs.metadata` de cada evento de MFA. */
type AuditMetadata = Partial<MfaAuditContext> & { factorId?: string };

/** Cuánto se espera a Supabase Auth. */
const TIMEOUT_MS = 10_000;

/** Con este nombre aparece la cuenta en la app autenticadora. */
const ISSUER = 'MediConnect';

/** Códigos fallidos seguidos de una misma persona antes de bloquear el segundo paso. */
const MAX_FALLOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

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
 * La persona no la puede escribir por PostgREST (trigger de la migración
 * `eng88_mfa_rls`), y la RLS exige `aal2` por su cuenta mirando los factores
 * (`public.mfa_ok()`), para quien llega a Supabase sin pasar por el backend.
 *
 * Es opcional y para los tres roles. No hay códigos de respaldo: si alguien
 * pierde el teléfono, un administrador borra el factor desde el panel de
 * Supabase (Authentication → Users → MFA) y pone `profiles.mfa_enabled` en
 * `false`.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  /**
   * Códigos fallidos en el segundo paso del ingreso, por usuario (id de
   * Supabase). Por usuario y no por token: con un login nuevo se consigue otro
   * token del primer paso, y si el contador fuera por token se reiniciaría.
   *
   * Es por proceso (en memoria): el proyecto no tiene un almacenamiento
   * compartido (Redis o similar). Con varias instancias del backend el límite
   * efectivo se multiplica por la cantidad de instancias y un reinicio lo
   * borra. El throttle por token pendiente y el rate limit de Supabase Auth
   * siguen acotando el ritmo.
   */
  private readonly fallos = new Map<
    string,
    { count: number; lockedUntil: number }
  >();

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
   * No pide re-autenticación: se deja registro en la auditoría
   * (`MFA_ENROLL_STARTED`) y solo se activa con un código válido.
   *
   * Un intento anterior que quedó a medias se borra antes: Supabase no deja dos
   * factores sin verificar, y el QR viejo ya no le sirve a nadie.
   */
  async startEnrollment(
    userId: string,
    accessToken: string,
    ctx?: MfaAuditContext,
  ): Promise<MfaEnrollment> {
    const factors = await this.factors(accessToken);
    if (this.pickVerified(factors)) {
      // Si una confirmación anterior verificó el factor pero no llegó a
      // guardar el perfil, se corrige acá: la verificación está activa en
      // Supabase y el guard tiene que exigirla.
      await this.setEnabledFlag(userId, true);
      throw new ConflictException(
        'Ya tenés activa la verificación en dos pasos.',
      );
    }
    // Solo los TOTP sin verificar: un factor de otro tipo no es de este flujo.
    for (const f of factors.filter(
      (x) => x.factor_type === 'totp' && x.status === 'unverified',
    )) {
      await this.request(
        'DELETE',
        `/factors/${encodeURIComponent(f.id)}`,
        accessToken,
      );
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
    // Sin pedir la contraseña de nuevo (menor impacto): queda registrado y la
    // activación igual exige un código del factor nuevo. Un aviso por mail
    // queda para cuando haya plantilla.
    await this.auditSinFallar(userId, 'MFA_ENROLL_STARTED', {
      ...ctx,
      factorId: res.id,
    });
    return { factorId: res.id, qr: res.totp.qr_code, secret: res.totp.secret };
  }

  /**
   * Confirma la activación con el primer código. Devuelve la sesión nueva, ya
   * con el segundo paso hecho: la anterior era `aal1` y, con la verificación
   * activa, el backend dejaría de aceptarla.
   *
   * Reintentable: si se verifica el factor y falla guardar el perfil, se
   * responde 503 y la persona confirma de nuevo con otro código (Supabase
   * acepta verificar un factor ya verificado) o vuelve a empezar el alta, que
   * corrige el perfil. Mientras tanto la sesión vieja sigue sirviendo, porque
   * el guard lee el perfil.
   */
  async confirmEnrollment(
    userId: string,
    accessToken: string,
    factorId: string,
    code: string,
    ctx?: MfaAuditContext,
  ): Promise<MfaSession> {
    const session = await this.verifyCode(
      userId,
      accessToken,
      factorId,
      code,
      ctx,
    );
    try {
      await this.setEnabledFlag(userId, true);
    } catch (err) {
      this.logger.error(
        `Factor ${factorId} verificado pero no se pudo activar mfa_enabled de ${userId}: ${String(err)}`,
      );
      throw new ServiceUnavailableException(
        'No pudimos terminar de activar la verificación en dos pasos. Probá confirmar de nuevo con el código que muestra ahora la app.',
      );
    }
    // Ya está activa: un fallo al auditar no puede convertirla en un error.
    await this.auditSinFallar(userId, 'MFA_ENABLED', { ...ctx, factorId });
    return session;
  }

  /**
   * El segundo paso del ingreso: con el token del primer paso (`aal1`) y el
   * código de la app, devuelve la sesión completa.
   */
  async verifyLogin(
    accessToken: string,
    code: string,
    ctx?: MfaAuditContext,
  ): Promise<MfaSession> {
    // Quién es sale del token (lo valida Supabase): el bloqueo es por persona.
    const me = await this.me(accessToken);
    const key = me.id;
    const lock = this.fallos.get(key);
    if (lock && lock.lockedUntil > Date.now()) {
      throw new HttpException(
        'Demasiados códigos incorrectos. Ingresá de nuevo con tu email y contraseña en unos minutos.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const factor = this.pickVerified(me.factors);
    if (!factor) {
      throw new BadRequestException(
        'Tu cuenta no tiene activa la verificación en dos pasos.',
      );
    }
    try {
      const session = await this.challengeAndVerify(
        accessToken,
        factor.id,
        code,
      );
      this.fallos.delete(key);
      await this.auditSinFallar(me.id, 'MFA_LOGIN_OK', {
        ...ctx,
        factorId: factor.id,
      });
      return session;
    } catch (err) {
      if (err instanceof BadRequestException) {
        const count = (lock?.count ?? 0) + 1;
        const locked = count >= MAX_FALLOS;
        if (this.fallos.size > 10_000) this.fallos.clear();
        this.fallos.set(key, {
          count: locked ? 0 : count,
          lockedUntil: locked ? Date.now() + BLOQUEO_MS : 0,
        });
        await this.auditSinFallar(
          me.id,
          locked ? 'MFA_LOGIN_LOCKED' : 'MFA_LOGIN_FAILED',
          { ...ctx, factorId: factor.id },
        );
      }
      throw err;
    }
  }

  /**
   * La desactiva. Pide un código igual, aunque la sesión ya tenga el segundo
   * paso: así una sesión abierta en una compu ajena no alcanza para sacarla.
   */
  async disable(
    userId: string,
    accessToken: string,
    code: string,
    ctx?: MfaAuditContext,
  ): Promise<void> {
    const factor = await this.verifiedFactor(accessToken);
    if (!factor) {
      throw new BadRequestException(
        'No tenés activa la verificación en dos pasos.',
      );
    }
    // Supabase exige una sesión `aal2` para borrar un factor verificado: se usa
    // la que devuelve el código recién verificado.
    const session = await this.verifyCode(
      userId,
      accessToken,
      factor.id,
      code,
      ctx,
    );
    // Primero la base: si fallara al revés (factor borrado y el perfil sin
    // actualizar), la cuenta quedaría bloqueada sin forma de entrar. Si falla
    // el borrado, se vuelve a activar.
    await this.prisma.profile.update({
      where: { id: userId },
      data: { mfa_enabled: false },
    });
    invalidateMfaCache(userId);
    try {
      await this.request(
        'DELETE',
        `/factors/${encodeURIComponent(factor.id)}`,
        session.accessToken,
      );
    } catch (err) {
      try {
        await this.prisma.profile.update({
          where: { id: userId },
          data: { mfa_enabled: true },
        });
      } catch (rollbackErr) {
        this.logger.error(
          `No se pudo restaurar mfa_enabled de ${userId}: ${String(rollbackErr)}`,
        );
      }
      invalidateMfaCache(userId);
      throw err;
    }
    // Ya está desactivada: un fallo al auditar no puede convertirla en un error.
    await this.auditSinFallar(userId, 'MFA_DISABLED', {
      ...ctx,
      factorId: factor.id,
    });
  }

  /**
   * `profiles.mfa_enabled` (lo lee `JwtAuthGuard`). Idempotente: se puede
   * llamar de nuevo con el mismo valor.
   */
  private async setEnabledFlag(userId: string, enabled: boolean) {
    await this.prisma.profile.update({
      where: { id: userId },
      data: { mfa_enabled: enabled },
    });
    invalidateMfaCache(userId);
  }

  /** El factor TOTP verificado de la persona, o `null`. */
  async verifiedFactor(accessToken: string): Promise<GoTrueFactor | null> {
    return this.pickVerified((await this.me(accessToken)).factors);
  }

  private pickVerified(factors: GoTrueFactor[]): GoTrueFactor | null {
    return (
      factors.find(
        (f) => f.factor_type === 'totp' && f.status === 'verified',
      ) ?? null
    );
  }

  private async me(
    accessToken: string,
  ): Promise<{ id: string; factors: GoTrueFactor[] }> {
    const user = await this.request<{
      id: string;
      factors?: GoTrueFactor[] | null;
    }>('GET', '/user', accessToken);
    return { id: user.id, factors: user.factors ?? [] };
  }

  private async factors(accessToken: string): Promise<GoTrueFactor[]> {
    return (await this.me(accessToken)).factors;
  }

  /** `challengeAndVerify` dejando en la auditoría los códigos incorrectos. */
  private async verifyCode(
    userId: string,
    accessToken: string,
    factorId: string,
    code: string,
    ctx?: MfaAuditContext,
  ): Promise<MfaSession> {
    try {
      return await this.challengeAndVerify(accessToken, factorId, code);
    } catch (err) {
      if (err instanceof BadRequestException) {
        await this.auditSinFallar(userId, 'MFA_CODE_FAILED', {
          ...ctx,
          factorId,
        });
      }
      throw err;
    }
  }

  /** Auditar un intento (ok o fallido) nunca tapa el resultado ni el error original. */
  private async auditSinFallar(
    userId: string,
    action: string,
    metadata?: AuditMetadata,
  ): Promise<void> {
    try {
      await this.audit(userId, action, metadata);
    } catch (err) {
      this.logger.error(`No se pudo auditar ${action}: ${String(err)}`);
    }
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

  private async audit(
    userId: string,
    action: string,
    metadata?: AuditMetadata,
  ): Promise<void> {
    // Sin las claves vacías: un `null` no aporta nada en la bitácora.
    const datos = Object.fromEntries(
      Object.entries(metadata ?? {}).filter(([, v]) => v != null),
    ) as Record<string, string>;
    await this.prisma.auditLog.create({
      data: {
        actor_id: userId,
        action,
        resource_type: 'profiles',
        resource_id: userId,
        ...(Object.keys(datos).length > 0 && { metadata: datos }),
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
      try {
        return (text ? JSON.parse(text) : {}) as T;
      } catch {
        // GoTrue devolvió 200 con algo que no es JSON (un proxy, una página de error).
        this.logger.error(`Supabase Auth ${method} ${path} no devolvió JSON`);
        throw new ServiceUnavailableException(
          'No pudimos completar la verificación en dos pasos. Probá de nuevo en unos minutos.',
        );
      }
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
