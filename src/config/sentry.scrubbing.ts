import type { Breadcrumb, ErrorEvent } from '@sentry/nestjs';

/**
 * Saneamiento de los eventos que se envían a Sentry (ENG-83).
 *
 * Sentry es un servicio de terceros: todo lo que se adjunte a un evento sale de
 * nuestra infraestructura. MediConnect maneja historia clínica (Ley 26.529) y
 * datos de salud, que la Ley 25.326 trata como dato sensible.
 *
 * La regla es la misma que ya aplica `RequestLoggerMiddleware`: no se reporta
 * body, headers, cookies ni query string, y al usuario se lo identifica por el
 * `sub` del JWT (uuid), nunca por su email. De poco serviría cuidar los logs si
 * los eventos de Sentry filtran lo mismo por otra vía.
 *
 * Se exportan como funciones puras (en vez de escribirlas inline en
 * `instrument.ts`) para poder testear el saneamiento sin inicializar el SDK.
 */

/**
 * Quita del evento todo lo que pueda contener datos sensibles antes de enviarlo.
 *
 * Del request se conserva únicamente método y ruta —lo mismo que loguea el
 * middleware HTTP—, ya que son necesarios para ubicar el error y no revelan
 * datos del paciente.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    const { url, method } = event.request;

    event.request = {
      // Sin query string: si alguna ruta futura recibiera un secreto o un id de
      // paciente por query (ej. un callback `?code=...`), no se filtra.
      ...(url !== undefined && { url: url.split('?')[0] }),
      ...(method !== undefined && { method }),
    };
  }

  // `sendDefaultPii: false` ya evita que el SDK adjunte IP y datos del usuario,
  // pero el `sub` puede llegar por otras vías (ej. `Sentry.setUser`). Nos
  // quedamos solo con el id y descartamos email, username e IP.
  if (event.user) {
    const { id } = event.user;

    event.user = id !== undefined ? { id } : {};
  }

  return event;
}

/**
 * Quita el payload de los breadcrumbs.
 *
 * Los breadcrumbs de HTTP y de consola arrastran cuerpos de request y lo que se
 * haya logueado. Se conserva la forma del breadcrumb (tipo, categoría, mensaje,
 * nivel), que es lo que sirve para reconstruir la secuencia previa al error.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (breadcrumb.data) {
    delete breadcrumb.data;
  }

  return breadcrumb;
}
