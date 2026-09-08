import { canonicalJson } from '../common/hash-chain/hash-chain';
import {
  CLINICAL_ENTRY_RESOURCE_TYPE,
  toClinicalImpression,
} from './clinical-entry.fhir';
import type { CreateClinicalEntryDto } from './dto/create-clinical-entry.dto';

/**
 * Mapeo del formulario a FHIR R5 (ENG-58).
 *
 * Importa más de lo que parece: lo que produce esta función entra a la preimagen
 * del hash, así que un cambio en la forma del recurso cambia el `content_hash` de
 * todo lo que se escriba después. Los tests fijan la forma, no solo el contenido.
 */

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';
const AT = new Date('2026-08-27T12:00:00.000Z');
const PARTIES = { patientId: PATIENT, professionalId: PROFESSIONAL };

function dto(
  overrides: Partial<CreateClinicalEntryDto> = {},
): CreateClinicalEntryDto {
  return {
    entryType: 'CONSULTA',
    reason: 'Control de rutina',
    ...overrides,
  };
}

describe('toClinicalImpression', () => {
  it('produce un ClinicalImpression completado', () => {
    const resource = toClinicalImpression(dto(), PARTIES, AT);

    expect(resource.resourceType).toBe(CLINICAL_ENTRY_RESOURCE_TYPE);
    // La tabla es append-only: no existe el estado "en progreso", porque no hay
    // forma de volver a editar la entrada.
    expect(resource.status).toBe('completed');
  });

  it('referencia al paciente y al profesional que firma', () => {
    const resource = toClinicalImpression(dto(), PARTIES, AT);

    expect(resource.subject).toEqual({ reference: `Patient/${PATIENT}` });
    expect(resource.performer).toEqual({
      reference: `Practitioner/${PROFESSIONAL}`,
    });
  });

  it('usa el mismo instante que se va a sellar', () => {
    const resource = toClinicalImpression(dto(), PARTIES, AT);

    expect(resource.date).toBe(AT.toISOString());
  });

  it('el motivo va en description', () => {
    const resource = toClinicalImpression(
      dto({ reason: 'Dolor lumbar de 3 días' }),
      PARTIES,
      AT,
    );

    expect(resource.description).toBe('Dolor lumbar de 3 días');
  });

  it('omite los campos opcionales vacíos en vez de mandarlos nulos', () => {
    // Un `summary: null` en un recurso FHIR no significa "no hay hallazgos": es
    // ruido que el receptor tiene que interpretar. Y cambia el hash.
    const resource = toClinicalImpression(dto(), PARTIES, AT);

    expect(resource).not.toHaveProperty('summary');
    expect(resource).not.toHaveProperty('finding');
    expect(resource).not.toHaveProperty('note');
  });

  it('mapea evolución, diagnóstico y plan cuando vienen', () => {
    const resource = toClinicalImpression(
      dto({
        findings: 'Buen estado general',
        diagnosis: 'Lumbalgia mecánica',
        plan: 'Reposo relativo y control en 7 días',
      }),
      PARTIES,
      AT,
    );

    expect(resource.summary).toBe('Buen estado general');
    // `finding` es una lista aunque hoy el formulario capture uno solo: agregar
    // el segundo no puede cambiar la forma del recurso ya escrito.
    expect(resource.finding).toEqual([
      { item: { concept: { text: 'Lumbalgia mecánica' } } },
    ]);
    expect(resource.note).toEqual([
      { text: 'Reposo relativo y control en 7 días' },
    ]);
  });

  it('un campo con string vacío se trata como ausente', () => {
    const resource = toClinicalImpression(
      dto({ findings: '', diagnosis: '', plan: '' }),
      PARTIES,
      AT,
    );

    expect(resource).not.toHaveProperty('summary');
    expect(resource).not.toHaveProperty('finding');
    expect(resource).not.toHaveProperty('note');
  });

  it('no inventa códigos SNOMED ni ICD-10', () => {
    // Un `coding` inventado es peor que no ponerlo: el sistema receptor lo leería
    // como si significara algo.
    const resource = toClinicalImpression(
      dto({ diagnosis: 'Lumbalgia mecánica' }),
      PARTIES,
      AT,
    );

    expect(JSON.stringify(resource)).not.toContain('"system"');
  });

  it('el recurso es serializable por la forma canónica del hash', () => {
    // Si tuviera un `undefined`, una función o un `NaN`, `canonicalJson` tiraría y
    // la entrada no se podría sellar.
    const resource = toClinicalImpression(
      dto({ findings: 'x', diagnosis: 'y', plan: 'z' }),
      PARTIES,
      AT,
    );

    expect(() => canonicalJson(resource)).not.toThrow();
  });

  it('el mismo formulario produce siempre el mismo recurso', () => {
    // Determinismo: dos entradas idénticas tienen que dar el mismo hash.
    expect(canonicalJson(toClinicalImpression(dto(), PARTIES, AT))).toBe(
      canonicalJson(toClinicalImpression(dto(), PARTIES, AT)),
    );
  });
});
