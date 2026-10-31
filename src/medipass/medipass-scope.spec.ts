import { applyScope, DEFAULT_SCOPE, resolveScope } from './medipass-scope';
import type { VitalBlock } from './vital-block';

const FICHA: VitalBlock = {
  nombre: 'Marina Ocampo',
  edad: 35,
  sexo: 'Femenino',
  grupoSanguineo: '0+',
  pais: null,
  alergias: [{ que: 'Penicilina', gravedad: 'Anafilaxia' }],
  medicacion: [{ droga: 'Enalapril', dosis: '10 mg', nota: null }],
  condiciones: [{ nombre: 'Hipertensión', codigo: 'I10' }],
  contacto: { nombre: 'Julián', vinculo: 'Hermano', telefono: '+54 351 555' },
};

describe('medipass-scope (ENG-149)', () => {
  it('test_should_apply_default_scope_given_patient_never_configured_it', () => {
    expect(resolveScope(null)).toEqual(DEFAULT_SCOPE);
    expect(Object.values(DEFAULT_SCOPE).every(Boolean)).toBe(true);
  });

  it('lo que no es booleano vale el default: no esconde nada por accidente', () => {
    expect(resolveScope({ alergias: 'no', medicacion: false })).toEqual({
      ...DEFAULT_SCOPE,
      medicacion: false,
    });
    expect(resolveScope(['raro'])).toEqual(DEFAULT_SCOPE);
  });

  it('test_should_omit_disabled_block_given_emergency_session_reads_vital', () => {
    const recortada = applyScope(FICHA, {
      ...DEFAULT_SCOPE,
      medicacion: false,
      contacto: false,
    });

    // Ni vacío ni en null: el consultante no distingue "lo ocultó" de "no lo cargó".
    expect('medicacion' in recortada).toBe(false);
    expect('contacto' in recortada).toBe(false);
    expect(recortada.alergias).toEqual(FICHA.alergias);
    // El nombre y la edad no se pueden apagar.
    expect(recortada.nombre).toBe('Marina Ocampo');
    expect(recortada.edad).toBe(35);
  });

  it('no toca la ficha original', () => {
    applyScope(FICHA, { ...DEFAULT_SCOPE, alergias: false });
    expect(FICHA.alergias).toHaveLength(1);
  });
});
