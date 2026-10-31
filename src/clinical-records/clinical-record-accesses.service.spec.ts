import { ClinicalRecordAccessesService } from './clinical-record-accesses.service';
import type { PrismaService } from '../prisma/prisma.service';

const PACIENTE = '11111111-1111-4111-8111-111111111111';

function fila(i: number, professional: unknown = PRO) {
  return {
    id: `log-${i}`,
    created_at: new Date(Date.UTC(2026, 9, 30, 12, 0, 0) - i * 60_000),
    actor: { professional },
  };
}

const PRO = {
  first_name: 'Ana',
  last_name: 'García',
  license_number: 'MP 45120',
  specialties: [{ specialty: { name: 'Cardiología' } }],
};

describe('ClinicalRecordAccessesService (ENG-165)', () => {
  let findMany: jest.Mock;
  let service: ClinicalRecordAccessesService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    service = new ClinicalRecordAccessesService({
      auditLog: { findMany },
    } as unknown as PrismaService);
  });

  it('test_should_list_professional_reads_given_patient_with_accesses', async () => {
    findMany.mockResolvedValue([fila(0)]);

    await expect(service.listMyAccesses(PACIENTE, 1)).resolves.toEqual({
      accesos: [
        {
          id: 'log-0',
          profesional: {
            nombre: 'Ana García',
            especialidad: 'Cardiología',
            matricula: 'MP 45120',
          },
          el: '2026-10-30T12:00:00.000Z',
        },
      ],
      pagina: 1,
      hayMas: false,
    });
  });

  it('test_should_not_return_other_patients_accesses_given_authenticated_patient', async () => {
    await service.listMyAccesses(PACIENTE, 1);

    const { where, orderBy } = findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
    };
    // Solo la HC del paciente del JWT, y sin sus propias lecturas.
    expect(where).toEqual({
      action: 'CLINICAL_RECORD_READ',
      resource_type: 'clinical_record_entries',
      resource_id: PACIENTE,
      NOT: { actor_id: PACIENTE },
    });
    expect(orderBy).toEqual({ created_at: 'desc' });
  });

  it('test_should_paginate_accesses_given_more_than_page_size', async () => {
    findMany.mockResolvedValue(Array.from({ length: 11 }, (_, i) => fila(i)));

    const pagina2 = await service.listMyAccesses(PACIENTE, 2);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 11 }),
    );
    expect(pagina2.accesos).toHaveLength(10);
    expect(pagina2.hayMas).toBe(true);
  });

  it('un profesional sin perfil (cuenta borrada) sale sin datos, no rompe', async () => {
    findMany.mockResolvedValue([fila(0, null)]);

    const { accesos } = await service.listMyAccesses(PACIENTE, 1);

    expect(accesos[0].profesional).toBeNull();
  });
});
