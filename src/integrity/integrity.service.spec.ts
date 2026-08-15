/**
 * ENG-85 — Tests del servicio de verificación con Prisma mockeado.
 *
 * Acá se prueba la orquestación, no la criptografía (eso es `chain-audit.spec.ts`
 * y `hash-chain.spec.ts`): a quién se verifica, qué se registra, cuándo se
 * alerta y —lo más importante— cuándo NO se pisa el snapshot.
 */
import { Logger } from '@nestjs/common';
import {
  appendEntry,
  GENESIS_HASH,
  type ChainEntry,
  type ChainEntryInput,
} from '../common/hash-chain/hash-chain';
import type { PrismaService } from '../prisma/prisma.service';
import { computeAnchor } from './chain-anchor';
import { IntegrityService } from './integrity.service';

const PROFESSIONAL_ID = '22222222-2222-4222-8222-222222222222';
const PACIENTE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const PACIENTE_B = 'bbbbbbbb-2222-4222-8222-222222222222';

function entryInput(
  patientId: string,
  sequenceNumber: number,
  value = 70,
): ChainEntryInput {
  return {
    patientId,
    professionalId: PROFESSIONAL_ID,
    sequenceNumber,
    entryType: 'CONSULTA',
    fhirResourceType: 'Observation',
    content: { resourceType: 'Observation', valueQuantity: { value } },
    createdAt: new Date(
      Date.UTC(2026, 7, 13, 12, 0, 0) + sequenceNumber * 1000,
    ),
  };
}

function buildChain(patientId: string, n: number): ChainEntry[] {
  const entries: ChainEntry[] = [];
  let previousHash = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const entry = appendEntry(entryInput(patientId, i, 60 + i), previousHash);
    entries.push(entry);
    previousHash = entry.contentHash;
  }
  return entries;
}

/** Entrada sellada -> fila tal como la devuelve Prisma (bigint, snake_case). */
function toRow(entry: ChainEntry) {
  return {
    patient_id: entry.patientId,
    professional_id: entry.professionalId,
    sequence_number: BigInt(entry.sequenceNumber),
    entry_type: entry.entryType,
    fhir_resource_type: entry.fhirResourceType,
    content: entry.content,
    consultation_id: entry.consultationId ?? null,
    corrects_entry_id: entry.correctsEntryId ?? null,
    created_at: entry.createdAt,
    content_hash: entry.contentHash,
    previous_hash: entry.previousHash,
  };
}

interface Harness {
  service: IntegrityService;
  prisma: {
    clinicalRecordEntry: { groupBy: jest.Mock; findMany: jest.Mock };
    chainHeadSnapshot: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      upsert: jest.Mock;
    };
    integrityCheck: { create: jest.Mock; findMany: jest.Mock };
  };
  alerter: {
    inconsistencyDetected: jest.Mock;
    runFailed: jest.Mock;
    anchorPublished: jest.Mock;
  };
}

/**
 * @param chains entradas por paciente, ya selladas.
 * @param snapshots cabeza que dejó la corrida anterior, por paciente.
 * @param previousChecks filas de `integrity_checks` que devuelve la búsqueda del
 *   ancla anterior (ENG-123). Vacío = primera corrida, no hay contra qué comparar.
 */
function harness(
  chains: Record<string, ChainEntry[]>,
  snapshots: Record<
    string,
    { head_hash: string; sequence_number: bigint }
  > = {},
  previousChecks: { details: unknown }[] = [],
): Harness {
  const prisma: Harness['prisma'] = {
    clinicalRecordEntry: {
      groupBy: jest.fn().mockResolvedValue(
        Object.entries(chains)
          .filter(([, entries]) => entries.length > 0)
          .map(([patient_id]) => ({ patient_id })),
      ),
      findMany: jest.fn(({ where }: { where: { patient_id: string } }) =>
        Promise.resolve((chains[where.patient_id] ?? []).map(toRow)),
      ),
    },
    chainHeadSnapshot: {
      findUnique: jest.fn(({ where }: { where: { patient_id: string } }) =>
        Promise.resolve(snapshots[where.patient_id] ?? null),
      ),
      findMany: jest
        .fn()
        .mockResolvedValue(
          Object.keys(snapshots).map((patient_id) => ({ patient_id })),
        ),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    integrityCheck: {
      create: jest.fn().mockResolvedValue({ id: 'check-1' }),
      // Ancla de la corrida anterior (ENG-123). Sin corridas previas, vacío.
      findMany: jest.fn().mockResolvedValue(previousChecks),
    },
  };

  const alerter = {
    inconsistencyDetected: jest.fn().mockResolvedValue(true),
    runFailed: jest.fn().mockResolvedValue(true),
    anchorPublished: jest.fn().mockResolvedValue(true),
  };

  return {
    prisma,
    alerter,
    service: new IntegrityService(prisma as unknown as PrismaService, alerter),
  };
}

/** Fila que el servicio mandó a escribir en `integrity_checks`. */
interface CreatedCheck {
  status: string;
  inconsistencies_found: number;
  details: {
    patients_checked: number;
    entries_checked: number;
    duration_ms: number;
    failures: Record<string, unknown>[];
    failures_omitted: number;
  };
}

function createdCheck(h: Harness): CreatedCheck {
  const [args] = h.prisma.integrityCheck.create.mock.calls[0] as [
    { data: CreatedCheck },
  ];
  return args.data;
}

describe('IntegrityService', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  describe('corrida sana', () => {
    it('registra OK, no alerta y sella la cabeza de cada paciente', async () => {
      const chainA = buildChain(PACIENTE_A, 3);
      const chainB = buildChain(PACIENTE_B, 2);
      const h = harness({ [PACIENTE_A]: chainA, [PACIENTE_B]: chainB });

      const result = await h.service.run();

      expect(result).toMatchObject({
        status: 'OK',
        patientsChecked: 2,
        entriesChecked: 5,
        failures: [],
        checkId: 'check-1',
      });
      expect(h.alerter.inconsistencyDetected).not.toHaveBeenCalled();
      expect(createdCheck(h)).toMatchObject({
        status: 'OK',
        inconsistencies_found: 0,
      });

      expect(h.prisma.chainHeadSnapshot.upsert).toHaveBeenCalledTimes(2);
      expect(h.prisma.chainHeadSnapshot.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { patient_id: PACIENTE_A },
          update: expect.objectContaining({
            head_hash: chainA[2].contentHash,
            sequence_number: 3,
          }),
        }),
      );
    });

    it('no falla ni sella nada cuando no hay ninguna HC todavía', async () => {
      const h = harness({});

      const result = await h.service.run();

      expect(result).toMatchObject({
        status: 'OK',
        patientsChecked: 0,
        entriesChecked: 0,
      });
      expect(h.prisma.chainHeadSnapshot.upsert).not.toHaveBeenCalled();
    });
  });

  describe('corrida con inconsistencias', () => {
    it('registra INCONSISTENT con el detalle y alerta una sola vez', async () => {
      const chain = buildChain(PACIENTE_A, 4);
      chain[1] = {
        ...chain[1],
        content: { resourceType: 'Observation', x: 1 },
      };
      const h = harness({ [PACIENTE_A]: chain });

      const result = await h.service.run();

      expect(result.status).toBe('INCONSISTENT');
      expect(result.failures).toEqual([
        expect.objectContaining({
          patientId: PACIENTE_A,
          sequenceNumber: 2,
          reason: 'CONTENT_TAMPERED',
        }),
      ]);

      expect(createdCheck(h)).toMatchObject({
        status: 'INCONSISTENT',
        inconsistencies_found: 1,
        details: expect.objectContaining({
          patients_checked: 1,
          entries_checked: 4,
          failures_omitted: 0,
          failures: [
            expect.objectContaining({
              patient_id: PACIENTE_A,
              sequence_number: 2,
              reason: 'CONTENT_TAMPERED',
            }),
          ],
        }),
      });

      expect(h.alerter.inconsistencyDetected).toHaveBeenCalledTimes(1);
    });

    it('escribe en `details` exactamente cinco campos por falla, sin nada del contenido clínico', async () => {
      const chain = buildChain(PACIENTE_A, 2);
      chain[1] = { ...chain[1], contentHash: '0'.repeat(64) };
      const h = harness({ [PACIENTE_A]: chain });

      await h.service.run();

      // `details` se puede terminar exponiendo en un panel de operaciones, así
      // que la forma de cada falla es contrato: si mañana `IntegrityFailure`
      // suma un campo con datos de la entrada, este test falla antes de que se
      // publique solo.
      for (const f of createdCheck(h).details.failures) {
        expect(Object.keys(f).sort()).toEqual([
          'expected',
          'found',
          'patient_id',
          'reason',
          'sequence_number',
        ]);
      }
    });

    it('NO pisa el snapshot del paciente con la cadena rota (si no, la manipulación queda blanqueada)', async () => {
      const chain = buildChain(PACIENTE_A, 4);
      const snapshotPrevio = {
        head_hash: chain[3].contentHash,
        sequence_number: 4n,
      };
      // Truncado de la cola: quedan 2 de 4.
      const h = harness(
        { [PACIENTE_A]: chain.slice(0, 2) },
        { [PACIENTE_A]: snapshotPrevio },
      );

      const result = await h.service.run();

      expect(result.failures[0]).toMatchObject({ reason: 'TAIL_TRUNCATED' });
      expect(h.prisma.chainHeadSnapshot.upsert).not.toHaveBeenCalled();
    });

    it('sella las cadenas sanas aunque otro paciente falle', async () => {
      const rota = buildChain(PACIENTE_A, 3);
      rota[0] = { ...rota[0], previousHash: 'f'.repeat(64) };
      const h = harness({
        [PACIENTE_A]: rota,
        [PACIENTE_B]: buildChain(PACIENTE_B, 2),
      });

      await h.service.run();

      expect(h.prisma.chainHeadSnapshot.upsert).toHaveBeenCalledTimes(1);
      expect(h.prisma.chainHeadSnapshot.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { patient_id: PACIENTE_B } }),
      );
    });

    it('detecta al paciente al que le borraron TODA la cadena', async () => {
      // Ya no tiene filas en clinical_record_entries: solo lo delata el snapshot.
      const h = harness(
        {},
        { [PACIENTE_A]: { head_hash: 'a'.repeat(64), sequence_number: 7n } },
      );

      const result = await h.service.run();

      expect(result.patientsChecked).toBe(1);
      expect(result.failures[0]).toMatchObject({
        patientId: PACIENTE_A,
        sequenceNumber: 0,
        reason: 'TAIL_TRUNCATED',
      });
    });

    it('recorta el detalle a 50 fallas pero cuenta todas', async () => {
      const chains: Record<string, ChainEntry[]> = {};
      for (let i = 0; i < 55; i++) {
        const patientId = `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`;
        const chain = buildChain(patientId, 2);
        chain[0] = { ...chain[0], contentHash: '0'.repeat(64) };
        chains[patientId] = chain;
      }
      const h = harness(chains);

      const result = await h.service.run();

      expect(result.failures).toHaveLength(55);
      expect(createdCheck(h)).toMatchObject({
        inconsistencies_found: 55,
        details: expect.objectContaining({ failures_omitted: 5 }),
      });
      expect(createdCheck(h).details.failures).toHaveLength(50);
    });
  });

  describe('ancla externa (ENG-123)', () => {
    it('publica el ancla de una corrida sana y la guarda en details', async () => {
      const chainA = buildChain(PACIENTE_A, 3);
      const h = harness({ [PACIENTE_A]: chainA });

      const result = await h.service.run();

      expect(result.anchor).toMatchObject({ patients: 1, entries: 3 });
      expect(result.anchor?.root).toMatch(/^[0-9a-f]{64}$/);
      expect(result.anchorRegression).toBe(false);

      expect(createdCheck(h).details).toMatchObject({
        anchor: {
          root: result.anchor?.root,
          patients: 1,
          entries: 3,
        },
        anchor_regression: false,
      });
      expect(h.alerter.anchorPublished).toHaveBeenCalledTimes(1);
    });

    it('el ancla se calcula sobre las cabezas reales de las cadenas', async () => {
      const chainA = buildChain(PACIENTE_A, 3);
      const chainB = buildChain(PACIENTE_B, 2);
      const h = harness({ [PACIENTE_A]: chainA, [PACIENTE_B]: chainB });

      const result = await h.service.run();

      const esperado = computeAnchor([
        {
          patientId: PACIENTE_A,
          sequenceNumber: 3,
          headHash: chainA[2].contentHash,
        },
        {
          patientId: PACIENTE_B,
          sequenceNumber: 2,
          headHash: chainB[1].contentHash,
        },
      ]);
      expect(result.anchor?.root).toBe(esperado.root);
    });

    it('NO ancla una corrida con inconsistencias', async () => {
      const chain = buildChain(PACIENTE_A, 3);
      chain[1] = { ...chain[1], contentHash: '0'.repeat(64) };
      const h = harness({ [PACIENTE_A]: chain });

      const result = await h.service.run();

      // Anclar un conjunto que incluye una cadena manipulada la convertiría en
      // la referencia buena de la semana siguiente.
      expect(result.anchor).toBeNull();
      expect(createdCheck(h).details).toMatchObject({ anchor: null });
      expect(h.alerter.anchorPublished).not.toHaveBeenCalled();
    });

    it('no manda el mensaje semanal mientras no haya ninguna HC', async () => {
      const h = harness({});

      const result = await h.service.run();

      // Hasta que ENG-57 escriba la primera entrada, anclar el conjunto vacío
      // sería un mensaje semanal sin información.
      expect(result.anchor).toMatchObject({ patients: 0 });
      expect(h.alerter.anchorPublished).not.toHaveBeenCalled();
    });

    it('detecta que la raíz se movió sin que la HC creciera', async () => {
      const chain = buildChain(PACIENTE_A, 3);
      // Ancla previa con el mismo total de entradas pero otra raíz: es lo que
      // deja una reescritura que también ajustó chain_head_snapshots.
      const anclaPrevia = computeAnchor([
        { patientId: PACIENTE_A, sequenceNumber: 3, headHash: 'f'.repeat(64) },
      ]);
      const h = harness({ [PACIENTE_A]: chain }, {}, [
        { details: { anchor: anclaPrevia } },
      ]);

      const result = await h.service.run();

      // Las verificaciones por paciente pasan: la cadena es coherente.
      expect(result.failures).toEqual([]);
      expect(result.status).toBe('OK');
      // Lo único que la delata es el ancla.
      expect(result.anchorRegression).toBe(true);
      expect(createdCheck(h).details).toMatchObject({
        anchor_regression: true,
      });
    });

    it('no marca regresión cuando la cadena simplemente creció', async () => {
      const chain = buildChain(PACIENTE_A, 5);
      const anclaPrevia = computeAnchor([
        { patientId: PACIENTE_A, sequenceNumber: 2, headHash: 'f'.repeat(64) },
      ]);
      const h = harness({ [PACIENTE_A]: chain }, {}, [
        { details: { anchor: anclaPrevia } },
      ]);

      const result = await h.service.run();

      expect(result.anchorRegression).toBe(false);
    });

    it('compara contra la última corrida OK, no contra una fila sin ancla', async () => {
      const chain = buildChain(PACIENTE_A, 3);
      // La búsqueda filtra por status OK; una fila sin ancla no debe tomarse
      // como referencia vacía y perder el punto de comparación.
      const h = harness({ [PACIENTE_A]: chain }, {}, [{ details: null }]);

      const result = await h.service.run();

      expect(result.anchorRegression).toBe(false);
      expect(h.prisma.integrityCheck.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'OK' } }),
      );
    });
  });
});
