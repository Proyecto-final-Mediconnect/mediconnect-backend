import {
  DEFAULT_CANCELLATION_POLICY,
  refundPercentFor,
  resolvePolicy,
  validatePolicy,
  type CancellationPolicy,
} from './cancellation-policy';

/**
 * Política de cancelación (ENG-67).
 *
 * `refundPercentFor` es **el contrato con ENG-65**: de lo que devuelve depende
 * cuánta plata se le reintegra a un paciente. Los casos de borde no son
 * minuciosidad: cada uno es un reclamo que alguien podría hacer.
 */

const POLITICA: CancellationPolicy = {
  hoursFullRefund: 24,
  hoursPartialRefund: 6,
  partialRefundPercent: 50,
};

const AHORA = new Date('2026-10-21T12:00:00.000Z');

/** Un turno `h` horas después de `AHORA`. */
function enHoras(h: number): Date {
  return new Date(AHORA.getTime() + h * 3_600_000);
}

describe('refundPercentFor', () => {
  it.each([
    [48, 100],
    [25, 100],
    [23, 50],
    [10, 50],
    [5, 0],
    [1, 0],
    [0, 0],
  ])('un turno en %i h devuelve %i %%', (horas, esperado) => {
    expect(refundPercentFor(POLITICA, enHoras(horas), AHORA)).toBe(esperado);
  });

  describe('los bordes favorecen al paciente', () => {
    it('exactamente 24 h antes devuelve el 100 %, no el 50 %', () => {
      // En el borde hay que elegir, y el sesgo va para el lado del que no
      // controla el sistema: alguien que miró el reloj y canceló a tiempo no
      // tiene que discutir segundos.
      expect(refundPercentFor(POLITICA, enHoras(24), AHORA)).toBe(100);
    });

    it('exactamente 6 h antes devuelve el 50 %, no 0', () => {
      expect(refundPercentFor(POLITICA, enHoras(6), AHORA)).toBe(50);
    });

    it('un milisegundo menos de 24 h ya es parcial', () => {
      const casi = new Date(enHoras(24).getTime() - 1);

      expect(refundPercentFor(POLITICA, casi, AHORA)).toBe(50);
    });
  });

  describe('turnos pasados', () => {
    it('un turno que ya pasó devuelve 0', () => {
      expect(refundPercentFor(POLITICA, enHoras(-2), AHORA)).toBe(0);
    });

    it('no devuelve negativos aunque el turno sea de hace meses', () => {
      expect(refundPercentFor(POLITICA, enHoras(-5000), AHORA)).toBe(0);
    });
  });

  describe('políticas en los extremos', () => {
    it('con 0 % parcial, la ventana intermedia no devuelve nada', () => {
      const sinParcial = { ...POLITICA, partialRefundPercent: 0 };

      expect(refundPercentFor(sinParcial, enHoras(10), AHORA)).toBe(0);
      expect(refundPercentFor(sinParcial, enHoras(30), AHORA)).toBe(100);
    });

    it('con 100 % parcial, la ventana intermedia equivale a la total', () => {
      const todoParcial = { ...POLITICA, partialRefundPercent: 100 };

      expect(refundPercentFor(todoParcial, enHoras(10), AHORA)).toBe(100);
    });

    it('con las dos ventanas iguales no queda tramo intermedio', () => {
      const sinIntermedio: CancellationPolicy = {
        hoursFullRefund: 24,
        hoursPartialRefund: 24,
        partialRefundPercent: 50,
      };

      expect(refundPercentFor(sinIntermedio, enHoras(24), AHORA)).toBe(100);
      expect(refundPercentFor(sinIntermedio, enHoras(23), AHORA)).toBe(0);
    });

    it('con 0 h para el total, cualquier turno futuro devuelve el 100 %', () => {
      const todoReembolsable: CancellationPolicy = {
        hoursFullRefund: 0,
        hoursPartialRefund: 0,
        partialRefundPercent: 50,
      };

      expect(refundPercentFor(todoReembolsable, enHoras(0.01), AHORA)).toBe(
        100,
      );
      // Y uno pasado sigue dando 0.
      expect(refundPercentFor(todoReembolsable, enHoras(-1), AHORA)).toBe(0);
    });
  });
});

describe('resolvePolicy', () => {
  it('sin fila devuelve el default y `configured: false`', () => {
    expect(resolvePolicy(null)).toEqual({
      policy: DEFAULT_CANCELLATION_POLICY,
      configured: false,
    });
  });

  it('con `undefined` se comporta igual que sin fila', () => {
    expect(resolvePolicy(undefined).configured).toBe(false);
  });

  it('con los tres valores devuelve la política del profesional', () => {
    expect(
      resolvePolicy({
        hours_full_refund: 48,
        hours_partial_refund: 12,
        partial_refund_percent: 30,
      }),
    ).toEqual({
      policy: {
        hoursFullRefund: 48,
        hoursPartialRefund: 12,
        partialRefundPercent: 30,
      },
      configured: true,
    });
  });

  it.each([
    ['hours_full_refund', { hours_full_refund: null }],
    ['hours_partial_refund', { hours_partial_refund: null }],
    ['partial_refund_percent', { partial_refund_percent: null }],
  ])('con %s en null cae al default entero', (_campo, parcial) => {
    // No se mezcla: un `hoursFullRefund` propio con un porcentaje del default da
    // una combinación que el profesional nunca eligió, y puede incluso violar el
    // invariante de que la ventana total esté más lejos que la parcial.
    const row = {
      hours_full_refund: 48,
      hours_partial_refund: 12,
      partial_refund_percent: 30,
      ...parcial,
    };

    expect(resolvePolicy(row)).toEqual({
      policy: DEFAULT_CANCELLATION_POLICY,
      configured: false,
    });
  });

  it('acepta 0 como valor configurado, no como ausente', () => {
    // `0` es falsy: con un chequeo por truthiness en lugar de `=== null`, una
    // política de "0 % en la ventana parcial" se leería como no configurada.
    const resuelto = resolvePolicy({
      hours_full_refund: 0,
      hours_partial_refund: 0,
      partial_refund_percent: 0,
    });

    expect(resuelto.configured).toBe(true);
    expect(resuelto.policy.partialRefundPercent).toBe(0);
  });
});

describe('validatePolicy', () => {
  it('acepta la ventana total más lejos que la parcial', () => {
    expect(validatePolicy(POLITICA)).toBeNull();
  });

  it('acepta las dos ventanas iguales', () => {
    expect(validatePolicy({ ...POLITICA, hoursPartialRefund: 24 })).toBeNull();
  });

  it('rechaza la parcial más lejos que la total', () => {
    // Sería una política donde el tramo parcial nunca se aplica: todo lo que
    // está más lejos que 6 h ya cae en el 100 %.
    const invertida = {
      hoursFullRefund: 6,
      hoursPartialRefund: 24,
      partialRefundPercent: 50,
    };

    expect(validatePolicy(invertida)).toMatch(/más lejos/);
  });

  it('el mensaje dice los dos números, así el profesional sabe qué corregir', () => {
    const mensaje = validatePolicy({
      hoursFullRefund: 2,
      hoursPartialRefund: 48,
      partialRefundPercent: 50,
    });

    expect(mensaje).toContain('2 h');
    expect(mensaje).toContain('48 h');
  });
});

describe('el default', () => {
  it('es 24 h / 6 h / 50 %, los valores que ya usa seed-demo', () => {
    // Si esto cambia, hay que cambiar `prisma/seed-demo.ts` en el mismo commit:
    // la demo dejaría de mostrar lo que el código aplica.
    expect(DEFAULT_CANCELLATION_POLICY).toEqual({
      hoursFullRefund: 24,
      hoursPartialRefund: 6,
      partialRefundPercent: 50,
    });
  });

  it('es una política válida', () => {
    expect(validatePolicy(DEFAULT_CANCELLATION_POLICY)).toBeNull();
  });
});
