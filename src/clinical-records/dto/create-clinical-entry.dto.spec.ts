import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateClinicalEntryDto } from './create-clinical-entry.dto';

async function invalidProps(obj: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(CreateClinicalEntryDto, obj);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

function transform(obj: Record<string, unknown>): CreateClinicalEntryDto {
  return plainToInstance(CreateClinicalEntryDto, obj);
}

/**
 * El DTO es la única barrera real: el formulario web valida, pero un cliente que
 * postea directo no pasa por él. Y como `clinical_record_entries` es append-only,
 * lo que entra mal no se puede borrar después.
 */
describe('CreateClinicalEntryDto', () => {
  const valid = {
    entryType: 'CONSULTA',
    reason: 'Control de rutina',
  };

  it('acepta el mínimo: tipo y motivo', async () => {
    expect(await invalidProps(valid)).toHaveLength(0);
  });

  describe('motivo', () => {
    it('rechaza el motivo vacío', async () => {
      expect(await invalidProps({ ...valid, reason: '' })).toContain('reason');
    });

    it('rechaza un motivo de solo espacios', async () => {
      expect(await invalidProps({ ...valid, reason: '   ' })).toContain(
        'reason',
      );
    });

    it('recorta el motivo antes de guardarlo', () => {
      expect(transform({ ...valid, reason: '  Control  ' }).reason).toBe(
        'Control',
      );
    });
  });

  describe('campos opcionales', () => {
    it('los recorta, así un "   " no llega al recurso FHIR', () => {
      const dto = transform({
        ...valid,
        findings: '  Sin hallazgos  ',
        diagnosis: '   ',
        plan: '  Reposo  ',
      });

      expect(dto.findings).toBe('Sin hallazgos');
      expect(dto.diagnosis).toBe('');
      expect(dto.plan).toBe('Reposo');
    });

    it('se pueden omitir', async () => {
      expect(await invalidProps(valid)).toHaveLength(0);
    });
  });

  describe('tipo de entrada', () => {
    it('rechaza CORRECCION: se crea desde ENG-100, no desde este formulario', async () => {
      expect(
        await invalidProps({ ...valid, entryType: 'CORRECCION' }),
      ).toContain('entryType');
    });

    it('rechaza un tipo inventado', async () => {
      expect(
        await invalidProps({ ...valid, entryType: 'LO_QUE_SEA' }),
      ).toContain('entryType');
    });
  });

  it('rechaza un consultationId que no es UUID', async () => {
    expect(
      await invalidProps({ ...valid, consultationId: 'no-es-uuid' }),
    ).toContain('consultationId');
  });
});
