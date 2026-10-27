import { decodeJwt } from 'jose';

/** `GET /conversations/realtime-token` (ENG-70). */
export interface RealtimeToken {
  accessToken: string;
  /** Cuándo vence, para que el cliente pida otro antes y lo pase a `realtime.setAuth()`. */
  expiraEl: string;
}

/**
 * Arma la respuesta a partir del token que ya verificó `JwtAuthGuard`.
 *
 * `decodeJwt` y no `jwtVerify`: la firma, el issuer y la audiencia ya se
 * chequearon en el guard. Acá solo se lee `exp`.
 */
export function toRealtimeToken(accessToken: string): RealtimeToken {
  const { exp } = decodeJwt(accessToken);
  return {
    accessToken,
    expiraEl: new Date((exp ?? 0) * 1000).toISOString(),
  };
}
