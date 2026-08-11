import * as Sentry from '@sentry/nestjs';
import { scrubBreadcrumb, scrubEvent } from './config/sentry.scrubbing';

/**
 * Inicialización de Sentry (ENG-83 / ENG-97).
 *
 * IMPORTANTE: este archivo debe importarse como PRIMERA línea de `main.ts`,
 * antes que cualquier otro import. El SDK instrumenta módulos (http, express,
 * etc.) parcheándolos, y solo puede hacerlo si corre antes de que esos módulos
 * se carguen. Si el orden se invierte la captura queda incompleta y falla en
 * silencio: no hay error, simplemente llegan menos eventos.
 *
 * Sin `SENTRY_DSN` el SDK queda inactivo y no envía nada. Es lo que permite que
 * el entorno local y el CI corran sin configuración extra y sin ensuciar el
 * dashboard con errores de desarrollo (ver `env.validation.ts`, donde la
 * variable está declarada como opcional).
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Permite separar producción de staging en el dashboard. Si no se declara,
  // cae a NODE_ENV para no dejar los eventos sin clasificar.
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,

  // Versión desplegada, para saber si un error es nuevo o venía de antes. En
  // Render se puede setear al SHA del commit desplegado.
  release: process.env.SENTRY_RELEASE,

  // No adjuntar IP, headers ni datos de usuario automáticamente: son datos
  // personales y acá se trata con pacientes (Ley 25.326). El `beforeSend`
  // refuerza esto por si algún dato llegara por otra vía.
  sendDefaultPii: false,

  // Performance tracing desactivado: este ticket entrega monitoreo de errores.
  // Habilitarlo implica muestrear requests (y su contexto) hacia un tercero, así
  // que es una decisión aparte y no se toma por default.
  tracesSampleRate: 0,

  // OJO: `beforeSend` corre sobre los eventos de error, NO sobre los envelopes
  // de sesión (Release Health), que se envían aparte. Verificado contra un
  // colector local: con esta configuración la sesión solo lleva release,
  // environment, user_agent y el id de usuario, sin datos personales. Pero si
  // alguna vez se llama a `Sentry.setUser` con email o `ip_address`, eso viaja
  // en la sesión salteándose este saneamiento. Regla: `setUser` recibe
  // únicamente el `sub` del JWT como `id`.
  beforeSend: (event) => scrubEvent(event),
  beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
});
