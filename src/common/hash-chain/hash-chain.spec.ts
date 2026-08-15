/**
 * ENG-45 — Tests unitarios del prototipo de cadena de hash.
 *
 * Cubren la lógica pura (canonicalización, sellado, verificación). La parte que
 * necesita una base real —append-only, enlace verificado por trigger— está en
 * test/hash-chain.integration.spec.ts.
 *
 * Todos los recursos FHIR de acá son sintéticos.
 */
import {
  appendEntry,
  canonicalJson,
  computeContentHash,
  GENESIS_HASH,
  verifyChain,
  type ChainEntry,
  type ChainEntryInput,
} from './hash-chain';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';

function observation(value: number): Record<string, unknown> {
  return {
    resourceType: 'Observation',
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
    valueQuantity: { value, unit: '/min' },
  };
}

function input(sequenceNumber: number, value = 70): ChainEntryInput {
  return {
    patientId: PATIENT,
    professionalId: PROFESSIONAL,
    sequenceNumber,
    entryType: 'CONSULTA',
    fhirResourceType: 'Observation',
    content: observation(value),
    createdAt: new Date(Date.UTC(2026, 7, 13, 10, 0, sequenceNumber)),
  };
}

/** Sella una cadena completa de `n` entradas. */
function buildChain(n: number): ChainEntry[] {
  const entries: ChainEntry[] = [];
  let previousHash = GENESIS_HASH;

  for (let i = 1; i <= n; i++) {
    const entry = appendEntry(input(i, 60 + i), previousHash);
    entries.push(entry);
    previousHash = entry.contentHash;
  }

  return entries;
}

describe('canonicalJson', () => {
  it('produce la misma salida sin importar el orden de las claves', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('ordena las claves anidadas y respeta el orden de los arrays', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [3, 1, 2] })).toBe(
      '{"a":[3,1,2],"z":{"x":2,"y":1}}',
    );
  });

  it('descarta undefined pero conserva null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('escapa los saltos de línea, así ningún contenido inyecta el separador', () => {
    expect(canonicalJson({ nota: 'linea1\nlinea2' })).toBe(
      '{"nota":"linea1\\nlinea2"}',
    );
  });

  it('rechaza valores que no sobreviven un round-trip JSON', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/no serializable/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/no serializable/);
  });
});

describe('computeContentHash', () => {
  it('devuelve 64 hex y es determinístico', () => {
    const hash = computeContentHash(input(1), GENESIS_HASH);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentHash(input(1), GENESIS_HASH)).toBe(hash);
  });

  it('cambia si cambia el contenido', () => {
    expect(computeContentHash(input(1, 70), GENESIS_HASH)).not.toBe(
      computeContentHash(input(1, 71), GENESIS_HASH),
    );
  });

  it('cambia si cambia el hash anterior, aunque el contenido sea idéntico', () => {
    expect(computeContentHash(input(1), GENESIS_HASH)).not.toBe(
      computeContentHash(input(1), 'a'.repeat(64)),
    );
  });

  it('cambia si se reasigna el profesional que firmó la entrada', () => {
    const base = input(1);

    expect(
      computeContentHash(
        { ...base, professionalId: '33333333-3333-4333-8333-333333333333' },
        GENESIS_HASH,
      ),
    ).not.toBe(computeContentHash(base, GENESIS_HASH));
  });

  it('cambia si cambia la consulta de origen', () => {
    const base = input(1);

    expect(
      computeContentHash(
        { ...base, consultationId: '44444444-4444-4444-8444-444444444444' },
        GENESIS_HASH,
      ),
    ).not.toBe(computeContentHash(base, GENESIS_HASH));
  });

  it('es insensible al orden de las claves del recurso FHIR', () => {
    const base = input(1);
    const reordenado: ChainEntryInput = {
      ...base,
      content: {
        valueQuantity: { unit: '/min', value: 70 },
        code: { coding: [{ code: '8867-4', system: 'http://loinc.org' }] },
        status: 'final',
        resourceType: 'Observation',
      },
    };

    expect(computeContentHash(reordenado, GENESIS_HASH)).toBe(
      computeContentHash(base, GENESIS_HASH),
    );
  });
});

describe('verifyChain', () => {
  it('acepta una cadena vacía y devuelve el hash génesis como cabeza', () => {
    expect(verifyChain([])).toEqual({
      valid: true,
      entries: 0,
      headHash: GENESIS_HASH,
    });
  });

  it('acepta una cadena íntegra', () => {
    const chain = buildChain(5);
    const result = verifyChain(chain);

    expect(result.valid).toBe(true);
    expect(result).toMatchObject({
      entries: 5,
      headHash: chain[4].contentHash,
    });
  });

  it('detecta contenido alterado sin recalcular el hash', () => {
    const chain = buildChain(5);
    chain[2] = { ...chain[2], content: observation(999) };

    const result = verifyChain(chain);

    expect(result.valid).toBe(false);
    expect(result).toMatchObject({
      failure: { sequenceNumber: 3, reason: 'CONTENT_TAMPERED' },
    });
  });

  it('detecta contenido alterado aun si el atacante recalcula ESE hash', () => {
    const chain = buildChain(5);
    const forged = { ...chain[2], content: observation(999) };
    // El atacante recalcula el hash de la entrada que tocó: esa entrada cierra,
    // pero la siguiente ya apunta al hash viejo. Ese es el punto de la cadena.
    chain[2] = {
      ...forged,
      contentHash: computeContentHash(forged, forged.previousHash),
    };

    const result = verifyChain(chain);

    expect(result.valid).toBe(false);
    expect(result).toMatchObject({
      failure: { sequenceNumber: 4, reason: 'BROKEN_LINK' },
    });
  });

  it('detecta una entrada eliminada del medio', () => {
    const chain = buildChain(5);
    chain.splice(2, 1);

    const result = verifyChain(chain);

    expect(result.valid).toBe(false);
    expect(result).toMatchObject({
      failure: { sequenceNumber: 4, reason: 'BROKEN_LINK' },
    });
  });

  it('detecta un hueco de secuencia con el enlace intacto', () => {
    const chain = buildChain(3);
    chain[1] = { ...chain[1], sequenceNumber: 7 };
    chain[2] = { ...chain[2], previousHash: chain[1].contentHash };

    const result = verifyChain(chain);

    expect(result.valid).toBe(false);
    expect(result).toMatchObject({
      failure: { sequenceNumber: 7, reason: 'SEQUENCE_GAP' },
    });
  });

  it('detecta una cadena que no arranca en el hash génesis', () => {
    const chain = buildChain(3);
    chain[0] = { ...chain[0], previousHash: 'f'.repeat(64) };

    const result = verifyChain(chain);

    expect(result.valid).toBe(false);
    expect(result).toMatchObject({
      failure: { sequenceNumber: 1, reason: 'GENESIS_MISMATCH' },
    });
  });

  it('verifica 1.000 entradas en menos de 1 segundo (criterio de ENG-45)', () => {
    const chain = buildChain(1000);

    const start = process.hrtime.bigint();
    const result = verifyChain(chain);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(result.valid).toBe(true);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
