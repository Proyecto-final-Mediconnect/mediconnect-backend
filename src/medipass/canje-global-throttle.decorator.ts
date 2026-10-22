import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';
import {
  CANJE_GLOBAL_LIMIT,
  CANJE_GLOBAL_THROTTLER,
  CANJE_GLOBAL_TRACKER,
} from './medipass.config';

/**
 * Techo global del canje del MediPass (ENG-170, hallazgo 2 de ENG-105).
 *
 * El canje ya tiene un límite de 10/min **por IP**, y ese no frena el ataque que
 * importa: quien prueba códigos no quiere la ficha de alguien en particular sino
 * *una* de cualquiera, así que reparte los intentos entre muchas IPs y nunca
 * alcanza el límite de ninguna. Con una botnet de 10.000 IPs son 100.000
 * intentos por minuto y el 50 % de probabilidad de sacar una ficha al azar en
 * 1,8 días. Ver `CANJE_GLOBAL_LIMIT` para el número elegido y el tradeoff.
 *
 * Vive acá y no inline en `AppModule` para que el predicado y el tracker se
 * puedan testear sin levantar la aplicación: son las dos piezas de las que
 * depende que el límite sea global **y** que no se coma el resto de la API.
 */

/** Marca el handler que cuenta contra el techo global. */
export const CANJE_GLOBAL_METADATA = 'medipass:canje-global-throttle';

/** Aplica el techo global del canje a este handler. */
export const CanjeGlobalThrottle = () =>
  SetMetadata(CANJE_GLOBAL_METADATA, true);

/**
 * Opciones del throttler nombrado, para `ThrottlerModule.forRoot`.
 *
 * Dos piezas, y las dos son necesarias:
 *
 * - **`getTracker` constante.** `ThrottlerGuard` cuenta por lo que devuelve el
 *   tracker, que normalmente es la IP del cliente. Devolver siempre lo mismo es
 *   lo que hace que todas las requests caigan en un único contador. Tiene
 *   precedencia sobre el `getTracker` de `ClientIpThrottlerGuard`, que sigue
 *   atendiendo al throttler `default`.
 * - **`skipIf` por metadata.** Los throttlers registrados en `forRoot` corren en
 *   **todas** las rutas. Sin este filtro, un tracker constante convertiría esto
 *   en un techo global de toda la API en lugar de uno del canje.
 */
export const canjeGlobalThrottler: ThrottlerOptions = {
  name: CANJE_GLOBAL_THROTTLER,
  ttl: 60_000,
  limit: CANJE_GLOBAL_LIMIT,
  getTracker: () => CANJE_GLOBAL_TRACKER,
  skipIf: (context: ExecutionContext) =>
    !Reflect.getMetadata(CANJE_GLOBAL_METADATA, context.getHandler()),
};
