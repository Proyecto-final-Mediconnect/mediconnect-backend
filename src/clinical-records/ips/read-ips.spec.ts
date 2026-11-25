import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidIpsError, readIps } from './read-ips';

/** El ejemplo oficial del grupo de trabajo IPS del Ministerio (SALUD-AR, Apache 2.0). */
const EJEMPLO: unknown = JSON.parse(
  readFileSync(
    join(__dirname, '../../../test/fixtures/ips-argentina-ejemplo.json'),
    'utf8',
  ),
);

/** Un documento mínimo con los recursos que se pasan. */
function documento(...recursos: Record<string, unknown>[]) {
  return {
    resourceType: 'Bundle',
    type: 'document',
    entry: [
      { resource: { resourceType: 'Composition', id: 'c', title: 'Resumen' } },
      ...recursos.map((resource) => ({ resource })),
    ],
  };
}

describe('readIps (ENG-246)', () => {
  it('test_should_propose_vital_items_given_official_ips_ar_example', () => {
    const preview = readIps(EJEMPLO);

    expect(preview.propuesta).toEqual({
      allergies: [{ que: 'Penicilina', gravedad: 'Grave' }],
      medications: [{ droga: 'Salbutamol 200 mcg', dosis: '1 disparo' }],
      conditions: [{ nombre: 'Asma', codigo: 'SNOMED 195967001' }],
    });
    expect(preview.vacunas).toEqual([
      {
        vacuna: 'Antígeno de virus de la influenza',
        fecha: '2017-05-22',
      },
    ]);
    expect(preview.documento).toEqual({
      titulo: 'Resumen del paciente al 26 de Enero de 2018, 14:30hs',
      fecha: '2018-01-26T14:30:00-03:00',
      dni: '99999999',
    });
    expect(preview.ignorados).toEqual([]);
  });

  it('test_should_reject_given_bundle_not_document', () => {
    expect(() =>
      readIps({ resourceType: 'Bundle', type: 'collection' }),
    ).toThrow(InvalidIpsError);
    expect(() => readIps({ resourceType: 'Patient' })).toThrow(InvalidIpsError);
    expect(() => readIps(null)).toThrow(InvalidIpsError);
    expect(() => readIps('texto')).toThrow(InvalidIpsError);
  });

  it('rechaza un documento sin Composition', () => {
    expect(() =>
      readIps({ resourceType: 'Bundle', type: 'document', entry: [] }),
    ).toThrow(/composición/);
  });

  it('deja afuera lo resuelto o inactivo y lo que no se toma más', () => {
    const preview = readIps(
      documento(
        {
          resourceType: 'Condition',
          clinicalStatus: { coding: [{ code: 'resolved' }] },
          code: { text: 'Varicela' },
        },
        {
          resourceType: 'AllergyIntolerance',
          clinicalStatus: { coding: [{ code: 'inactive' }] },
          code: { text: 'Polen' },
        },
        {
          resourceType: 'MedicationStatement',
          status: 'completed',
          medicationCodeableConcept: { text: 'Amoxicilina' },
        },
      ),
    );

    expect(preview.propuesta).toEqual({
      allergies: [],
      medications: [],
      conditions: [],
    });
  });

  it('sin principios activos usa el nombre del medicamento, y sin cantidad el texto de la dosis', () => {
    const preview = readIps(
      documento({
        resourceType: 'MedicationStatement',
        medicationCodeableConcept: {
          coding: [
            {
              system: 'http://snomed.info/sct',
              display: 'enalapril (sustancia)',
            },
          ],
        },
        dosage: [{ text: '10 mg cada 12 h' }],
      }),
    );

    expect(preview.propuesta.medications).toEqual([
      { droga: 'Enalapril', dosis: '10 mg cada 12 h' },
    ]);
  });

  it('no repite lo que el documento lista dos veces, y respeta los topes del DTO', () => {
    const largo = 'x'.repeat(300);
    const preview = readIps(
      documento(
        { resourceType: 'AllergyIntolerance', code: { text: 'Penicilina' } },
        { resourceType: 'AllergyIntolerance', code: { text: 'penicilina' } },
        { resourceType: 'Condition', code: { text: largo } },
      ),
    );

    expect(preview.propuesta.allergies).toEqual([{ que: 'Penicilina' }]);
    expect(preview.propuesta.conditions[0].nombre).toHaveLength(120);
  });

  it('informa lo que no conoce, sin fallar', () => {
    const preview = readIps(
      documento(
        { resourceType: 'Observation', code: { text: 'Peso' } },
        { resourceType: 'Observation', code: { text: 'Talla' } },
      ),
    );

    expect(preview.ignorados).toEqual([
      'Observation: no es parte del MediPass.',
    ]);
  });

  it('ignora entradas mal formadas', () => {
    const preview = readIps({
      resourceType: 'Bundle',
      type: 'document',
      entry: [
        null,
        'x',
        { resource: { resourceType: 'Composition' } },
        { resource: { resourceType: 'AllergyIntolerance', code: 42 } },
      ],
    });

    expect(preview.propuesta.allergies).toEqual([]);
    expect(preview.documento).toEqual({ titulo: null, fecha: null, dni: null });
  });

  // En el MediPass, "A qué" es la sustancia: así "Penicilina" que ya cargó el
  // paciente y la "alergia a la penicilina" del resumen son la misma.
  it('deja la sustancia de cada alergia y los nombres con mayúscula, como los escribe el paciente', () => {
    const preview = readIps(
      documento(
        {
          resourceType: 'AllergyIntolerance',
          code: { text: 'alergia al látex (trastorno)' },
        },
        {
          resourceType: 'AllergyIntolerance',
          code: { text: 'Alergia a los mariscos' },
        },
        {
          resourceType: 'AllergyIntolerance',
          code: { text: 'intolerancia a la lactosa' },
        },
        {
          resourceType: 'Condition',
          code: { text: 'diabetes mellitus tipo 2' },
        },
        {
          resourceType: 'Immunization',
          vaccineCode: {
            text: 'producto que contiene exactamente vacuna antitetánica',
          },
        },
      ),
    );

    expect(preview.propuesta.allergies).toEqual([
      { que: 'Látex' },
      { que: 'Mariscos' },
      { que: 'Intolerancia a la lactosa' },
    ]);
    expect(preview.propuesta.conditions).toEqual([
      { nombre: 'Diabetes mellitus tipo 2' },
    ]);
    expect(preview.vacunas).toEqual([
      { vacuna: 'Vacuna antitetánica', fecha: null },
    ]);
  });
});
