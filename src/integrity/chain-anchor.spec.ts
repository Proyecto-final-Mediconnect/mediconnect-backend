/**
 * ENG-123 — Tests del cálculo del ancla.
 *
 * Dos propiedades sostienen todo lo demás y por eso son la mayoría de los tests:
 *
 *   - **Determinismo.** Si dos corridas sobre los mismos datos dieran raíces
 *     distintas, el ancla no serviría para comparar nada y el equipo aprendería
 *     a ignorar la alerta. Es el modo de fallo más probable, porque depende del
 *     orden en que la base devuelva las filas.
 *   - **Sensibilidad.** Cambiar un solo bit de una sola cabeza tiene que cambiar
 *     la raíz. Si no, hay manipulaciones que el ancla no cubre.
 */
import { randomUUID } from 'node:crypto';
import {
  anchorRegressed,
  computeAnchor,
  EMPTY_ANCHOR_ROOT,
  type AnchoredHead,
} from './chain-anchor';

function head(
  patientId: string,
  sequenceNumber: number,
  seed = 'a',
): AnchoredHead {
  return {
    patientId,
    sequenceNumber,
    headHash: seed.repeat(64).slice(0, 64),
  };
}

/** Tres pacientes con UUIDs que NO están en orden alfabético de creación. */
const P1 = 'cccccccc-1111-4111-8111-111111111111';
const P2 = 'aaaaaaaa-2222-4222-8222-222222222222';
const P3 = 'bbbbbbbb-3333-4333-8333-333333333333';

describe('computeAnchor', () => {
  describe('determinismo', () => {
    it('la misma entrada produce la misma raíz', () => {
      const heads = [head(P1, 3), head(P2, 7, 'b'), head(P3, 1, 'c')];

      expect(computeAnchor(heads).root).toBe(computeAnchor(heads).root);
    });

    it('el orden en que vengan las cabezas NO cambia la raíz', () => {
      const heads = [head(P1, 3), head(P2, 7, 'b'), head(P3, 1, 'c')];
      const alRevés = [...heads].reverse();
      const mezclado = [heads[1], heads[2], heads[0]];

      // Es el test que importa: la base puede devolver las filas en cualquier
      // orden y la raíz tiene que salir igual.
      expect(computeAnchor(alRevés).root).toBe(computeAnchor(heads).root);
      expect(computeAnchor(mezclado).root).toBe(computeAnchor(heads).root);
    });

    it('no muta el array que recibe', () => {
      const heads = [head(P1, 3), head(P2, 7, 'b')];
      const copia = [...heads];

      computeAnchor(heads);

      expect(heads).toEqual(copia);
    });

    it('la raíz de una base sin Historia Clínica es la constante documentada', () => {
      const anchor = computeAnchor([]);

      expect(anchor.root).toBe(EMPTY_ANCHOR_ROOT);
      expect(anchor).toMatchObject({ patients: 0, entries: 0 });
    });
  });

  describe('sensibilidad', () => {
    it('cambia si cambia el hash de una sola cabeza', () => {
      const original = [head(P1, 3), head(P2, 7, 'b')];
      const tocado = [head(P1, 3, 'f'), head(P2, 7, 'b')];

      expect(computeAnchor(tocado).root).not.toBe(computeAnchor(original).root);
    });

    it('cambia si cambia el sequence_number de una sola cabeza', () => {
      const original = [head(P1, 3), head(P2, 7, 'b')];
      const tocado = [head(P1, 4), head(P2, 7, 'b')];

      expect(computeAnchor(tocado).root).not.toBe(computeAnchor(original).root);
    });

    it('cambia si desaparece un paciente entero', () => {
      const original = [head(P1, 3), head(P2, 7, 'b'), head(P3, 1, 'c')];
      const sinP3 = [head(P1, 3), head(P2, 7, 'b')];

      expect(computeAnchor(sinP3).root).not.toBe(computeAnchor(original).root);
    });

    it('distingue mover una entrada de un paciente a otro', () => {
      // Mismo total de entradas, distinto reparto. Sin el patient_id en la
      // preimagen las dos darían la misma raíz.
      const a = [head(P1, 5), head(P2, 3, 'b')];
      const b = [head(P1, 3), head(P2, 5, 'b')];

      expect(computeAnchor(a).root).not.toBe(computeAnchor(b).root);
    });
  });

  describe('contadores', () => {
    it('suma las entradas a partir del sequence_number de cada cabeza', () => {
      const anchor = computeAnchor([
        head(P1, 3),
        head(P2, 7, 'b'),
        head(P3, 1, 'c'),
      ]);

      expect(anchor).toMatchObject({ patients: 3, entries: 11 });
    });
  });

  it('escala a un padrón grande sin colisionar', () => {
    const heads = Array.from({ length: 2000 }, () => head(randomUUID(), 4));
    const otro = [...heads.slice(0, 1999), head(randomUUID(), 4)];

    expect(computeAnchor(heads).patients).toBe(2000);
    expect(computeAnchor(otro).root).not.toBe(computeAnchor(heads).root);
  });
});

describe('anchorRegressed', () => {
  const anterior = computeAnchor([head(P1, 3), head(P2, 7, 'b')]);

  it('no marca nada en la primera corrida', () => {
    expect(anchorRegressed(anterior, null)).toBe(false);
  });

  it('no marca nada si la raíz no cambió', () => {
    expect(anchorRegressed(anterior, anterior)).toBe(false);
  });

  it('NO marca el crecimiento legítimo, aunque la raíz cambie', () => {
    // Este es el falso positivo que hay que evitar: la raíz cambia con cada
    // entrada nueva, y eso es lo normal, no una alarma.
    const creció = computeAnchor([head(P1, 4), head(P2, 7, 'b')]);

    expect(creció.root).not.toBe(anterior.root);
    expect(anchorRegressed(creció, anterior)).toBe(false);
  });

  it('no marca nada cuando se suma un paciente nuevo', () => {
    const conPacienteNuevo = computeAnchor([
      head(P1, 3),
      head(P2, 7, 'b'),
      head(P3, 1, 'c'),
    ]);

    expect(anchorRegressed(conPacienteNuevo, anterior)).toBe(false);
  });

  it('MARCA una reescritura: la raíz cambió y el total de entradas no subió', () => {
    // El ataque que sobrevive a las verificaciones por paciente: se reescribió
    // el contenido y se ajustó también `chain_head_snapshots`, así que la cadena
    // verifica. Pero la tabla es append-only: que el contenido cambie sin que el
    // total crezca no tiene explicación legítima.
    const reescrito = computeAnchor([head(P1, 3, 'f'), head(P2, 7, 'b')]);

    expect(reescrito.entries).toBe(anterior.entries);
    expect(anchorRegressed(reescrito, anterior)).toBe(true);
  });

  it('MARCA un borrado: menos entradas que la corrida anterior', () => {
    const truncado = computeAnchor([head(P1, 3), head(P2, 5, 'b')]);

    expect(anchorRegressed(truncado, anterior)).toBe(true);
  });

  it('MARCA el borrado de un paciente entero', () => {
    const sinP2 = computeAnchor([head(P1, 3)]);

    expect(anchorRegressed(sinP2, anterior)).toBe(true);
  });
});
