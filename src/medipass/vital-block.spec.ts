import { ageAt, toVitalBlock } from './vital-block';

describe('ageAt', () => {
  it('cuenta años cumplidos, no diferencia de años', () => {
    // Cumple el 31 de diciembre: el 30 todavía tiene la edad anterior.
    const nacimiento = new Date('1990-12-31T00:00:00.000Z');
    expect(ageAt(nacimiento, new Date('2026-12-30T12:00:00.000Z'))).toBe(35);
    expect(ageAt(nacimiento, new Date('2026-12-31T12:00:00.000Z'))).toBe(36);
  });

  it('el día del cumpleaños ya cuenta', () => {
    expect(
      ageAt(
        new Date('2000-06-15T00:00:00.000Z'),
        new Date('2026-06-15T00:00:00.000Z'),
      ),
    ).toBe(26);
  });

  it('no depende del huso del servidor', () => {
    // `birth_date` es un `date` sin zona. Construirlo en hora local haría que
    // para alguien nacido un 1° de enero la edad cambiara según dónde corra
    // esto, que es el bug que el cálculo en UTC evita.
    const nacimiento = new Date('2000-01-01T00:00:00.000Z');
    expect(ageAt(nacimiento, new Date('2026-01-01T02:00:00.000Z'))).toBe(26);
    expect(ageAt(nacimiento, new Date('2025-12-31T22:00:00.000Z'))).toBe(25);
  });
});

describe('toVitalBlock', () => {
  const AHORA = new Date('2026-10-20T15:00:00.000Z');

  it('arma el nombre completo y la edad', () => {
    const vital = toVitalBlock(
      {
        first_name: 'Marina',
        last_name: 'Ocampo',
        birth_date: new Date('1991-03-02T00:00:00.000Z'),
      },
      AHORA,
    );

    expect(vital.nombre).toBe('Marina Ocampo');
    expect(vital.edad).toBe(35);
  });

  it('sin fecha de nacimiento la edad es null, no 0 ni NaN', () => {
    const vital = toVitalBlock(
      { first_name: 'Marina', last_name: 'Ocampo', birth_date: null },
      AHORA,
    );

    expect(vital.edad).toBeNull();
  });

  it('los campos clínicos salen en null hasta ENG-134', () => {
    // Si esto se rompe es porque ENG-134 agregó las columnas: hay que mapearlas
    // acá y actualizar este test, no borrarlo.
    const vital = toVitalBlock(
      { first_name: 'Marina', last_name: 'Ocampo', birth_date: null },
      AHORA,
    );

    expect(vital.grupoSanguineo).toBeNull();
    expect(vital.alergias).toBeNull();
    expect(vital.medicacion).toBeNull();
    expect(vital.condiciones).toBeNull();
    expect(vital.contacto).toBeNull();
    expect(vital.sexo).toBeNull();
    expect(vital.pais).toBeNull();
  });

  it('no deja el nombre con espacios de sobra', () => {
    const vital = toVitalBlock(
      { first_name: 'Marina', last_name: '', birth_date: null },
      AHORA,
    );

    expect(vital.nombre).toBe('Marina');
  });
});
