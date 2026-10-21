import type { ExecutionContext } from '@nestjs/common';
import {
  CANJE_GLOBAL_METADATA,
  CanjeGlobalThrottle,
  canjeGlobalThrottler,
} from './canje-global-throttle.decorator';
import {
  CANJE_GLOBAL_LIMIT,
  CANJE_GLOBAL_THROTTLER,
  CANJE_GLOBAL_TRACKER,
} from './medipass.config';
import { MediPassSessionsController } from './medipass-sessions.controller';

/**
 * Techo global del canje (ENG-170, hallazgo 2 de ENG-105).
 *
 * Lo que se verifica son las dos propiedades de las que depende que el límite
 * sirva: que **no** dependa de la IP —si dependiera, no frenaría el ataque
 * distribuido, que es el único que importa acá— y que **solo** cuente el canje,
 * porque un tracker constante aplicado a toda la API sería un techo global de
 * todo el backend.
 */

/** Un `ExecutionContext` con lo mínimo que usa el `skipIf`. */
function contextoDe(handler: unknown): ExecutionContext {
  return { getHandler: () => handler } as unknown as ExecutionContext;
}

/**
 * La función de un método, que es donde `SetMetadata` deja la metadata y lo que
 * devuelve `context.getHandler()`.
 *
 * Se saca del descriptor y no con `Clase.prototype.metodo` porque lo que hace
 * falta es el objeto función, no un método para invocar — y referenciarlo
 * suelto es justo lo que `@typescript-eslint/unbound-method` marca.
 */
function handlerDe(prototipo: object, metodo: string): object {
  const descriptor = Object.getOwnPropertyDescriptor(prototipo, metodo);
  expect(descriptor).toBeDefined();
  return descriptor!.value as object;
}

describe('canjeGlobalThrottler', () => {
  it('usa el throttler nombrado y el límite de la config', () => {
    expect(canjeGlobalThrottler.name).toBe(CANJE_GLOBAL_THROTTLER);
    expect(canjeGlobalThrottler.limit).toBe(CANJE_GLOBAL_LIMIT);
    expect(canjeGlobalThrottler.ttl).toBe(60_000);
  });

  describe('el contador es global, no por IP', () => {
    it('devuelve la misma clave para IPs distintas', async () => {
      // Es la propiedad que hace al límite global. Si el tracker variara con la
      // IP, una botnet seguiría teniendo su cupo por cada IP y el límite no
      // frenaría nada.
      const tracker = canjeGlobalThrottler.getTracker;
      expect(tracker).toBeDefined();

      const unaIp = await tracker!(
        { ip: '200.0.0.1' },
        contextoDe(() => undefined),
      );
      const otraIp = await tracker!(
        { ip: '45.33.99.7' },
        contextoDe(() => undefined),
      );

      expect(unaIp).toBe(CANJE_GLOBAL_TRACKER);
      expect(otraIp).toBe(CANJE_GLOBAL_TRACKER);
      expect(unaIp).toBe(otraIp);
    });

    it('no mira la request siquiera', async () => {
      const tracker = canjeGlobalThrottler.getTracker;

      expect(
        await tracker!(
          {},
          contextoDe(() => undefined),
        ),
      ).toBe(CANJE_GLOBAL_TRACKER);
    });
  });

  describe('solo cuenta el canje', () => {
    it('no saltea el handler marcado', () => {
      class Falso {
        @CanjeGlobalThrottle()
        canjear() {}
      }

      const skip = canjeGlobalThrottler.skipIf;
      expect(skip!(contextoDe(handlerDe(Falso.prototype, 'canjear')))).toBe(
        false,
      );
    });

    it('saltea un handler sin el marcador', () => {
      // Sin esto, el tracker constante convertiría este límite en un techo
      // global de toda la API: cada request de cualquier endpoint sumaría al
      // mismo contador.
      class Falso {
        otraRuta() {}
      }

      const skip = canjeGlobalThrottler.skipIf;
      expect(skip!(contextoDe(handlerDe(Falso.prototype, 'otraRuta')))).toBe(
        true,
      );
    });

    it('el canje real está marcado', () => {
      // El acople es por metadata, así que si alguien mueve la ruta o le saca el
      // decorador el límite desaparece en silencio. Esto lo ancla al controller
      // de verdad.
      expect(
        Reflect.getMetadata(
          CANJE_GLOBAL_METADATA,
          handlerDe(MediPassSessionsController.prototype, 'open'),
        ),
      ).toBe(true);
    });

    it('el polling de la sesión NO está marcado', () => {
      // Es el otro lado del tradeoff del techo global: si alguien lo quema, las
      // sesiones ya abiertas tienen que seguir funcionando. Un médico en medio
      // de una consulta no puede quedarse sin la ficha.
      expect(
        Reflect.getMetadata(
          CANJE_GLOBAL_METADATA,
          handlerDe(MediPassSessionsController.prototype, 'status'),
        ),
      ).toBeUndefined();
    });
  });
});
