import {
  CONSULTANTE_SIN_NOMBRE,
  toMediPassAccess,
  type AccessSource,
} from './medipass-access';

/**
 * Mapeo de un acceso del MediPass (ENG-74).
 *
 * Lo que se verifica acá es la forma del contrato con la web y la cuenta de
 * minutos. El filtro de vigencia no es de este archivo: se evalúa en la consulta
 * del service y se testea en `medipass.service.spec.ts`.
 */

const AHORA = new Date('2026-10-21T15:00:00.000Z');

function sesion(overrides: Partial<AccessSource> = {}): AccessSource {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    consultant_name: 'Dr. Pablo Rivas',
    consultant_license: 'MP 12345',
    started_at: new Date('2026-10-21T14:50:00.000Z'),
    expires_at: new Date('2026-10-21T15:20:00.000Z'),
    ...overrides,
  };
}

describe('toMediPassAccess', () => {
  it('devuelve la forma que consume la web', () => {
    expect(toMediPassAccess(sesion(), AHORA)).toEqual({
      id: '55555555-5555-4555-8555-555555555555',
      consultante: 'Dr. Pablo Rivas',
      matricula: 'MP 12345',
      desde: '2026-10-21T14:50:00.000Z',
      expiraEl: '2026-10-21T15:20:00.000Z',
      minutosRestantes: 20,
    });
  });

  it('el id es el de la sesión, que es lo que recibe el DELETE', () => {
    // Si acá saliera el id del código en vez del de la sesión, el paciente
    // apretaría "cortar" y revocaría otra cosa, o nada.
    const access = toMediPassAccess(
      sesion({ id: '66666666-6666-4666-8666-666666666666' }),
      AHORA,
    );

    expect(access.id).toBe('66666666-6666-4666-8666-666666666666');
  });

  describe('minutosRestantes', () => {
    it('redondea hacia arriba', () => {
      // 30 segundos todavía son un acceso abierto.
      const access = toMediPassAccess(
        sesion({ expires_at: new Date('2026-10-21T15:00:30.000Z') }),
        AHORA,
      );

      expect(access.minutosRestantes).toBe(1);
    });

    it('un acceso vivo nunca muestra 0', () => {
      // Es el motivo del `ceil`: mientras el consultante puede leer la ficha, la
      // pantalla del paciente tiene que decir que alguien la está mirando.
      const access = toMediPassAccess(
        sesion({ expires_at: new Date('2026-10-21T15:00:00.001Z') }),
        AHORA,
      );

      expect(access.minutosRestantes).toBe(1);
    });

    it('no devuelve negativos si la fila venció entre la consulta y el mapeo', () => {
      const access = toMediPassAccess(
        sesion({ expires_at: new Date('2026-10-21T14:55:00.000Z') }),
        AHORA,
      );

      expect(access.minutosRestantes).toBe(0);
    });
  });

  describe('consultante', () => {
    it('sin matrícula devuelve null, no una cadena vacía', () => {
      // La pantalla distingue "no la dejó" de "la dejó en blanco".
      const access = toMediPassAccess(
        sesion({ consultant_license: null }),
        AHORA,
      );

      expect(access.matricula).toBeNull();
    });

    it('sin nombre usa una etiqueta y no deja el hueco', () => {
      const access = toMediPassAccess(sesion({ consultant_name: null }), AHORA);

      expect(access.consultante).toBe(CONSULTANTE_SIN_NOMBRE);
    });
  });
});
