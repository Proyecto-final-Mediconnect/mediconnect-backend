import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { generateKeyPair, SignJWT } from 'jose';
import { JWKSTimeout } from 'jose/errors';
import { LegalAcceptedGuard } from '../../legal/legal-accepted.guard';
import { SupabaseService } from '../../supabase/supabase.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from './jwt-auth.guard';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const AUDIENCE = 'authenticated';

function makeContext(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  // La aceptación legal tiene su propio spec: acá solo importa que se invoque
  // después de autenticar y que su resultado sea el del guard.
  const legalCanActivate = jest.fn();
  /** `profiles.mfa_enabled` (ENG-88): solo se lee para las sesiones `aal1`. */
  const profileFindUnique = jest.fn();
  const prisma = {
    profile: { findUnique: profileFindUnique },
  } as unknown as PrismaService;

  const legalAccepted = {
    canActivate: legalCanActivate,
  } as unknown as LegalAcceptedGuard;
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;
  let rsaPrivateKey: CryptoKey;

  async function sign(
    overrides: {
      issuer?: string;
      audience?: string;
      expired?: boolean;
      sub?: string | null;
      email?: string;
      role?: string;
      aal?: 'aal1' | 'aal2';
    } = {},
  ): Promise<string> {
    const jwt = new SignJWT({
      email: overrides.email ?? 'paciente@test.com',
      role: overrides.role ?? 'authenticated',
      ...(overrides.aal && { aal: overrides.aal }),
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(overrides.issuer ?? ISSUER)
      .setAudience(overrides.audience ?? AUDIENCE)
      .setIssuedAt();

    if (overrides.sub !== null) {
      jwt.setSubject(overrides.sub ?? 'user-id-123');
    }

    if (overrides.expired) {
      jwt.setExpirationTime('-1h');
    } else {
      jwt.setExpirationTime('1h');
    }

    return jwt.sign(privateKey);
  }

  beforeAll(async () => {
    const keyPair = await generateKeyPair('ES256');
    publicKey = keyPair.publicKey;
    privateKey = keyPair.privateKey;
    ({ privateKey: rsaPrivateKey } = await generateKeyPair('RS256'));
  });

  beforeEach(() => {
    const supabase = {
      getJWKS: () => publicKey,
      getIssuer: () => ISSUER,
    } as unknown as SupabaseService;
    legalCanActivate.mockReset().mockResolvedValue(true);
    profileFindUnique.mockReset().mockResolvedValue({ mfa_enabled: false });
    guard = new JwtAuthGuard(supabase, legalAccepted, prisma);
  });

  it('permite el acceso con un token válido en el header Authorization y adjunta el usuario', async () => {
    const token = await sign();
    const request: { headers: Record<string, string>; user?: unknown } = {
      headers: { authorization: `Bearer ${token}` },
    };

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 'user-id-123',
      email: 'paciente@test.com',
      role: 'authenticated',
    });
  });

  it('permite el acceso con un token válido en la cookie sb-access-token', async () => {
    const token = await sign();
    const request = {
      headers: {},
      cookies: { 'sb-access-token': token },
    };

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
  });

  it('rechaza si no hay token', async () => {
    const request = { headers: {}, cookies: {} };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un token expirado', async () => {
    const token = await sign({ expired: true });
    const request = { headers: { authorization: `Bearer ${token}` } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un token con issuer incorrecto', async () => {
    const token = await sign({
      issuer: 'https://otro-proyecto.supabase.co/auth/v1',
    });
    const request = { headers: { authorization: `Bearer ${token}` } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un token con audiencia incorrecta', async () => {
    const token = await sign({ audience: 'anon' });
    const request = { headers: { authorization: `Bearer ${token}` } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un token firmado con un algoritmo no permitido (RS256)', async () => {
    const token = await new SignJWT({
      email: 'paciente@test.com',
      role: 'authenticated',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user-id-123')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(rsaPrivateKey);
    const request = { headers: { authorization: `Bearer ${token}` } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un token sin sub', async () => {
    const token = await sign({ sub: null });
    const request = { headers: { authorization: `Bearer ${token}` } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un token con firma manipulada', async () => {
    const token = await sign();
    const tampered = token.slice(0, -3) + 'AAA';
    const request = { headers: { authorization: `Bearer ${tampered}` } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('responde 503 (no 401) si el JWKS no responde (timeout)', async () => {
    const supabase = {
      getJWKS: () => {
        throw new JWKSTimeout();
      },
      getIssuer: () => ISSUER,
    } as unknown as SupabaseService;
    guard = new JwtAuthGuard(supabase, legalAccepted, prisma);

    const token = await sign();
    const request = { headers: { authorization: `Bearer ${token}` } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('responde 503 (no 401) ante un error de red al buscar el JWKS', async () => {
    const supabase = {
      getJWKS: () => {
        throw new TypeError('fetch failed');
      },
      getIssuer: () => ISSUER,
    } as unknown as SupabaseService;
    guard = new JwtAuthGuard(supabase, legalAccepted, prisma);

    const token = await sign();
    const request = { headers: { authorization: `Bearer ${token}` } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('exige la aceptación legal recién después de adjuntar el usuario', async () => {
    const token = await sign();
    const request: { headers: Record<string, string>; user?: unknown } = {
      headers: { authorization: `Bearer ${token}` },
    };
    legalCanActivate.mockImplementation(() => {
      // Cuando corre, el usuario ya está en el request.
      expect(request.user).toEqual(
        expect.objectContaining({ id: 'user-id-123' }),
      );
      return Promise.reject(new ForbiddenException());
    });

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      ForbiddenException,
    );
    expect(legalCanActivate).toHaveBeenCalledTimes(1);
  });

  it('no consulta la aceptación legal si el token es inválido (401 antes que 403)', async () => {
    const request = { headers: { authorization: 'Bearer basura' } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(legalCanActivate).not.toHaveBeenCalled();
  });

  describe('verificación en dos pasos (ENG-88)', () => {
    function requestWith(token: string) {
      return { headers: { authorization: `Bearer ${token}` } };
    }

    it('con la verificación activa, una sesión sin el segundo paso (aal1) da 401', async () => {
      profileFindUnique.mockResolvedValue({ mfa_enabled: true });
      const token = await sign({ aal: 'aal1' });

      await expect(
        guard.canActivate(makeContext(requestWith(token))),
      ).rejects.toThrow(UnauthorizedException);
      expect(legalCanActivate).not.toHaveBeenCalled();
    });

    it('sin la verificación activa, una sesión aal1 pasa como siempre', async () => {
      const token = await sign({ aal: 'aal1' });

      await expect(
        guard.canActivate(makeContext(requestWith(token))),
      ).resolves.toBe(true);
      expect(profileFindUnique).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        select: { mfa_enabled: true },
      });
    });

    it('una sesión con el segundo paso (aal2) pasa sin consultar la base', async () => {
      profileFindUnique.mockResolvedValue({ mfa_enabled: true });
      const token = await sign({ aal: 'aal2' });

      await expect(
        guard.canActivate(makeContext(requestWith(token))),
      ).resolves.toBe(true);
      expect(profileFindUnique).not.toHaveBeenCalled();
    });
  });
});
