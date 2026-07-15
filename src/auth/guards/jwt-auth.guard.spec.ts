import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { generateKeyPair, SignJWT } from 'jose';
import { SupabaseService } from '../../supabase/supabase.service';
import { JwtAuthGuard } from './jwt-auth.guard';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';

function makeContext(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;

  async function sign(
    overrides: {
      issuer?: string;
      expired?: boolean;
      sub?: string;
      email?: string;
      role?: string;
    } = {},
  ): Promise<string> {
    const jwt = new SignJWT({
      email: overrides.email ?? 'paciente@test.com',
      role: overrides.role ?? 'authenticated',
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(overrides.sub ?? 'user-id-123')
      .setIssuer(overrides.issuer ?? ISSUER)
      .setIssuedAt();

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
  });

  beforeEach(() => {
    const supabase = {
      getJWKS: () => publicKey,
      getIssuer: () => ISSUER,
    } as unknown as SupabaseService;
    guard = new JwtAuthGuard(supabase);
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

  it('rechaza un token con firma manipulada', async () => {
    const token = await sign();
    const tampered = token.slice(0, -3) + 'AAA';
    const request = { headers: { authorization: `Bearer ${tampered}` } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
