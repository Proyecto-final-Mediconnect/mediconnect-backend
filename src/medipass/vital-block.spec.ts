import { ageAt, toVitalBlock, type PatientVitalSource } from './vital-block';

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

const AHORA = new Date('2026-10-21T15:00:00.000Z');

/** Un paciente sin nada cargado. Los tests pisan solo lo que les importa. */
function paciente(extra: Partial<PatientVitalSource> = {}): PatientVitalSource {
  return {
    first_name: 'Marina',
    last_name: 'Ocampo',
    birth_date: new Date('1991-03-02T00:00:00.000Z'),
    sex: null,
    blood_type: null,
    allergies: null,
    medications: null,
    conditions: null,
    emergency_contact: null,
    ...extra,
  };
}

describe('toVitalBlock', () => {
  it('arma el nombre completo y la edad', () => {
    const vital = toVitalBlock(paciente(), AHORA);

    expect(vital.nombre).toBe('Marina Ocampo');
    expect(vital.edad).toBe(35);
  });

  it('sin fecha de nacimiento la edad es null, no 0 ni NaN', () => {
    expect(toVitalBlock(paciente({ birth_date: null }), AHORA).edad).toBeNull();
  });

  it('no deja el nombre con espacios de sobra', () => {
    expect(toVitalBlock(paciente({ last_name: '' }), AHORA).nombre).toBe(
      'Marina',
    );
  });

  it('devuelve los seis campos vitales cuando están cargados', () => {
    const vital = toVitalBlock(
      paciente({
        sex: 'femenino',
        blood_type: '0+',
        allergies: [{ que: 'Penicilina', gravedad: 'alta' }],
        medications: [
          { droga: 'Levotiroxina', dosis: '75 mcg', nota: 'en ayunas' },
        ],
        conditions: [{ nombre: 'Hipotiroidismo', codigo: 'E03.9' }],
        emergency_contact: {
          nombre: 'Jorge Ocampo',
          vinculo: 'padre',
          telefono: '+54 11 5555-1234',
        },
      }),
      AHORA,
    );

    expect(vital.sexo).toBe('femenino');
    expect(vital.grupoSanguineo).toBe('0+');
    expect(vital.alergias).toEqual([{ que: 'Penicilina', gravedad: 'alta' }]);
    expect(vital.medicacion).toEqual([
      { droga: 'Levotiroxina', dosis: '75 mcg', nota: 'en ayunas' },
    ]);
    expect(vital.condiciones).toEqual([
      { nombre: 'Hipotiroidismo', codigo: 'E03.9' },
    ]);
    expect(vital.contacto).toEqual({
      nombre: 'Jorge Ocampo',
      vinculo: 'padre',
      telefono: '+54 11 5555-1234',
    });
  });

  it('pais sigue en null: ENG-134 no definió columna para él', () => {
    expect(toVitalBlock(paciente(), AHORA).pais).toBeNull();
  });

  describe('lee los jsonb a la defensiva', () => {
    // La columna acepta cualquier JSON válido y no hay CHECK que la acote. Esto
    // corre en la ficha de emergencia de alguien en una urgencia: una fila mal
    // cargada tiene que degradar a "ese campo no se muestra", nunca a un 500
    // que deje al médico sin la ficha entera.

    it('lo que no es una lista se descarta entero', () => {
      const vital = toVitalBlock(
        paciente({
          allergies: 'Penicilina',
          medications: { droga: 'Levotiroxina' },
          conditions: 42,
        }),
        AHORA,
      );

      expect(vital.alergias).toBeNull();
      expect(vital.medicacion).toBeNull();
      expect(vital.condiciones).toBeNull();
    });

    it('una entrada malformada no se lleva a las demás', () => {
      const vital = toVitalBlock(
        paciente({
          allergies: [
            { que: 'Penicilina', gravedad: 'alta' },
            null,
            'AAS',
            { gravedad: 'baja' },
            { que: '   ' },
            { que: 'Nueces', gravedad: 'media' },
          ],
        }),
        AHORA,
      );

      expect(vital.alergias).toEqual([
        { que: 'Penicilina', gravedad: 'alta' },
        { que: 'Nueces', gravedad: 'media' },
      ]);
    });

    it('una lista que queda vacía vuelve como null, no como []', () => {
      // Un array vacío le haría dibujar a la pantalla la sección con nada
      // adentro; `null` es lo que sabe omitir.
      expect(
        toVitalBlock(paciente({ allergies: [{ gravedad: 'alta' }] }), AHORA)
          .alergias,
      ).toBeNull();
      expect(
        toVitalBlock(paciente({ allergies: [] }), AHORA).alergias,
      ).toBeNull();
    });

    it('una alergia sin gravedad se conserva: a qué es alérgico ya sirve', () => {
      const vital = toVitalBlock(
        paciente({ allergies: [{ que: 'Penicilina' }] }),
        AHORA,
      );

      // Vacío y no "sin especificar": no se le inventa texto a la pantalla de
      // un médico.
      expect(vital.alergias).toEqual([{ que: 'Penicilina', gravedad: '' }]);
    });

    it('una medicación sin droga se descarta, sin dosis se conserva', () => {
      const vital = toVitalBlock(
        paciente({
          medications: [{ dosis: '75 mcg' }, { droga: 'Levotiroxina' }],
        }),
        AHORA,
      );

      expect(vital.medicacion).toEqual([
        { droga: 'Levotiroxina', dosis: '', nota: null },
      ]);
    });

    it('el contacto sin teléfono se descarta: no se puede llamar a nadie', () => {
      expect(
        toVitalBlock(
          paciente({
            emergency_contact: { nombre: 'Jorge', vinculo: 'padre' },
          }),
          AHORA,
        ).contacto,
      ).toBeNull();
    });

    it('el contacto sin vínculo se conserva', () => {
      expect(
        toVitalBlock(
          paciente({
            emergency_contact: { nombre: 'Jorge', telefono: '1155551234' },
          }),
          AHORA,
        ).contacto,
      ).toEqual({ nombre: 'Jorge', telefono: '1155551234', vinculo: '' });
    });

    it('los textos vacíos o con espacios vuelven como null', () => {
      const vital = toVitalBlock(
        paciente({ sex: '   ', blood_type: '' }),
        AHORA,
      );

      expect(vital.sexo).toBeNull();
      expect(vital.grupoSanguineo).toBeNull();
    });

    it('recorta los espacios de lo que viene cargado con ellos', () => {
      expect(
        toVitalBlock(paciente({ blood_type: ' 0+ ' }), AHORA).grupoSanguineo,
      ).toBe('0+');
    });
  });
});
