import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CorrectClinicalEntryDto } from './correct-clinical-entry.dto';

async function invalidProps(obj: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(CorrectClinicalEntryDto, obj);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

function transform(obj: Record<string, unknown>): CorrectClinicalEntryDto {
  return plainToInstance(CorrectClinicalEntryDto, obj);
}

/**
 * DTO de la corrección (ENG-100).
 *
 * Importa lo mismo que el del alta y un poco más: una corrección mal cargada
 * agrega un asiento equivocado ENCIMA de otro asiento equivocado, y ninguno de
 * los dos se puede borrar.
 */
describe('CorrectClinicalEntryDto', () => {
  const valid = {
    reason: 'Control de rutina',
    correctionReason: 'El diagnóstico quedó cargado en el paciente equivocado',
  };

  it('acepta el mínimo: motivo del asiento y motivo de la corrección', async () => {
    expect(await invalidProps(valid)).toHaveLength(0);
  });

  describe('motivo de la corrección', () => {
    it('es obligatorio: sin él la HC queda con dos asientos sin explicación', async () => {
      expect(await invalidProps({ reason: valid.reason })).toContain(
        'correctionReason',
      );
    });

    it('rechaza solo espacios', async () => {
      expect(
        await invalidProps({ ...valid, correctionReason: '   ' }),
      ).toContain('correctionReason');
    });

    it('lo recorta', () => {
      expect(
        transform({ ...valid, correctionReason: '  Error de tipeo  ' })
          .correctionReason,
      ).toBe('Error de tipeo');
    });

    it('rechaza más de 1000 caracteres', async () => {
      expect(
        await invalidProps({ ...valid, correctionReason: 'x'.repeat(1001) }),
      ).toContain('correctionReason');
    });
  });

  describe('hereda los campos clínicos del alta', () => {
    it('el motivo del asiento sigue siendo obligatorio', async () => {
      expect(await invalidProps({ ...valid, reason: '' })).toContain('reason');
    });

    it('recorta los opcionales', () => {
      const dto = transform({
        ...valid,
        findings: '  Sin hallazgos  ',
        plan: '  Reposo  ',
      });

      expect(dto.findings).toBe('Sin hallazgos');
      expect(dto.plan).toBe('Reposo');
    });
  });

  describe('lo que no se acepta del cuerpo', () => {
    /**
     * `forbidNonWhitelisted` es lo que rechaza el request, y vive en el
     * `ValidationPipe` global (ver `main.ts`) — no en el DTO. Lo que se verifica
     * acá es que estas propiedades **no estén declaradas**, que es la condición
     * para que el pipe las considere no permitidas.
     */
    it.each(['entryType', 'correctsEntryId', 'consultationId'])(
      '%s no es una propiedad del DTO',
      (prop) => {
        expect(new CorrectClinicalEntryDto()).not.toHaveProperty(prop);
      },
    );
  });
});
