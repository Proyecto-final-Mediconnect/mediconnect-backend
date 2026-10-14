import { SetMetadata } from '@nestjs/common';

export const SKIP_LEGAL_KEY = 'skipLegal';

/**
 * Exime a un handler o a un controller de exigir la aceptación vigente de los
 * textos legales (ENG-140). Ver `LegalAcceptedGuard`.
 *
 * Va en las rutas que el usuario necesita **antes** de aceptar: leer su perfil
 * (`GET /me`, que informa `legalAccepted`) y aceptar (`POST
 * /me/legal-acceptance`). En las rutas públicas (`/auth/*`, health, webhooks,
 * catálogo) es declarativo: no pasan por `JwtAuthGuard`, así que no hay usuario
 * y nada que chequear. Se marca igual para que quede explícito que no tratan
 * datos de un usuario sin consentimiento y para que sigan andando si algún día
 * la autenticación pasa a ser global.
 */
export const SkipLegal = () => SetMetadata(SKIP_LEGAL_KEY, true);
