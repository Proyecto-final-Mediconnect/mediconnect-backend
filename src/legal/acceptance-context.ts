import type { Request } from 'express';
import { clientIp } from '../common/http/client-ip';

/** Largo de `legal_acceptances.user_agent` (VARCHAR(512)). */
const USER_AGENT_MAX_LENGTH = 512;

/**
 * Desde dónde se aceptaron los textos legales (ENG-140): se guarda junto con la
 * aceptación como parte de la prueba del consentimiento.
 */
export interface LegalAcceptanceContext {
  /** IP real del cliente (ENG-84); `null` si no se pudo determinar. */
  ip: string | null;
  userAgent: string | null;
}

export function legalAcceptanceContext(req: Request): LegalAcceptanceContext {
  const userAgent = req.headers['user-agent'];
  return {
    ip: clientIp(req),
    // Se recorta en vez de rechazar: un user-agent largo no puede impedir que
    // quede registrada la aceptación.
    userAgent: userAgent ? userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null,
  };
}
