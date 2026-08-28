/**
 * ENG-85 — Tests de la auditoría de cadena.
 *
 * Los cuatro motivos que ya cubre `verifyChain` (ENG-45) se prueban acá otra vez
 * a propósito, pero desde la salida de `auditPatientChain`: lo que importa no es
 * que la cadena esté rota sino que la falla llegue con el paciente y la posición
 * correctos, que es lo que después se escribe en `integrity_checks` y se manda a
 * Slack.
 *
 * Los dos motivos propios de ENG-85 —TAIL_TRUNCATED e HISTORY_REWRITTEN— son la
 * razón de ser de este módulo: son exactamente los dos ataques que el spike
 * ENG-45 documentó como invisibles para una cadena de hash aislada.
 */
import { randomUUID } from 'node:crypto';
import {
  appendEntry,
  GENESIS_HASH,
  type ChainEntry,
  type ChainEntryInput,
} from '../common/hash-chain/hash-chain';
import { auditPatientChain, type ChainHead } from './chain-audit';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const PROFESSIONAL_ID = '22222222-2222-4222-8222-222222222222';

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
    // Recurso FHIR sintético.
    content: {
      resourceType: 'Observation',
      status: 'final',
      valueQuantity: { value, unit: '/min' },
    },
    createdAt: new Date(
      Date.UTC(2026, 7, 13, 12, 0, 0) + sequenceNumber * 1000,
    ),
  };
}

/** Sella `n` entradas encadenadas para un paciente. */
function buildChain(n: number, patientId = PATIENT_ID): ChainEntry[] {
  const entries: ChainEntry[] = [];
  let previousHash = GENESIS_HASH;

  for (let i = 1; i <= n; i++) {
    const entry = appendEntry(entryInput(patientId, i, 60 + i), previousHash);
    entries.push(entry);
    previousHash = entry.contentHash;
  }

  return entries;
}

/** La cabeza tal como la habría guardado la corrida anterior. */
function headOf(entries: ChainEntry[]): ChainHead {
  const last = entries[entries.length - 1];
  return { headHash: last.contentHash, sequenceNumber: last.sequenceNumber };
}

describe('auditPatientChain', () => {
  describe('cadenas sanas', () => {
    it('acepta una cadena íntegra y devuelve su cabeza', () => {
      const entries = buildChain(5);

      const audit = auditPatientChain(PATIENT_ID, entries, null);

      expect(audit).toMatchObject({ ok: true, entries: 5 });
      if (!audit.ok) throw new Error('esperaba una cadena válida');
      expect(audit.head).toEqual({
        headHash: entries[4].contentHash,
        sequenceNumber: 5,
      });
    });

    it('acepta la primera corrida de un paciente (todavía sin snapshot)', () => {
      expect(auditPatientChain(PATIENT_ID, buildChain(3), null).ok).toBe(true);
    });

    it('acepta el crecimiento normal: la cadena avanzó sobre la cabeza anterior', () => {
      const entries = buildChain(8);
      const snapshotDeLaCorridaAnterior = headOf(entries.slice(0, 5));

      const audit = auditPatientChain(
        PATIENT_ID,
        entries,
        snapshotDeLaCorridaAnterior,
      );

      expect(audit).toMatchObject({ ok: true, entries: 8 });
    });

    it('acepta un paciente sin entradas y sin snapshot, y no propone cabeza', () => {
      const audit = auditPatientChain(PATIENT_ID, [], null);

      expect(audit).toMatchObject({ ok: true, entries: 0 });
      if (!audit.ok) throw new Error('esperaba una cadena válida');
      expect(audit.head).toBeNull();
    });
  });

  describe('lo que ya detectaba verifyChain, con el paciente en la falla', () => {
    it('CONTENT_TAMPERED cuando se reescribe el contenido de una entrada', () => {
      const entries = buildChain(4);
      // El atacante cambia el contenido pero no puede recalcular el hash sin
      // reescribir todo lo que sigue.
      entries[2] = {
        ...entries[2],
        content: {
          resourceType: 'Observation',
          status: 'final',
          tampered: true,
        },
      };

      const audit = auditPatientChain(PATIENT_ID, entries, null);

      expect(audit).toMatchObject({
        ok: false,
        failure: {
          patientId: PATIENT_ID,
          sequenceNumber: 3,
          reason: 'CONTENT_TAMPERED',
        },
      });
    });

    it('CONTENT_TAMPERED cuando se reasigna el profesional firmante', () => {
      const entries = buildChain(3);
      entries[1] = {
        ...entries[1],
        professionalId: '33333333-3333-4333-8333-333333333333',
      };

      const audit = auditPatientChain(PATIENT_ID, entries, null);

      expect(audit).toMatchObject({
        ok: false,
        failure: { sequenceNumber: 2, reason: 'CONTENT_TAMPERED' },
      });
    });

    it('BROKEN_LINK cuando se borra una entrada del medio', () => {
      const entries = buildChain(5);
      entries.splice(2, 1); // se va la seq 3

      const audit = auditPatientChain(PATIENT_ID, entries, null);

      expect(audit).toMatchObject({
        ok: false,
        failure: { sequenceNumber: 4, reason: 'BROKEN_LINK' },
      });
    });

    it('GENESIS_MISMATCH cuando la cadena no arranca en el génesis', () => {
      const entries = buildChain(3).slice(1);

      const audit = auditPatientChain(PATIENT_ID, entries, null);

      expect(audit).toMatchObject({
        ok: false,
        failure: { sequenceNumber: 2, reason: 'GENESIS_MISMATCH' },
      });
    });
  });

  describe('lo que solo se ve contra la corrida anterior', () => {
    it('TAIL_TRUNCATED cuando se borran las últimas entradas', () => {
      const completa = buildChain(10);
      const snapshot = headOf(completa);
      // Se borran las 3 últimas. Lo que queda sigue contiguo, enlazado y
      // arrancando en el génesis: sin snapshot esto pasa por sano.
      const truncada = completa.slice(0, 7);

      expect(auditPatientChain(PATIENT_ID, truncada, null).ok).toBe(true);

      const audit = auditPatientChain(PATIENT_ID, truncada, snapshot);

      expect(audit).toMatchObject({
        ok: false,
        failure: {
          patientId: PATIENT_ID,
          sequenceNumber: 7,
          reason: 'TAIL_TRUNCATED',
          expected: 'sequence_number >= 10',
          found: 'sequence_number = 7',
        },
      });
    });

    it('TAIL_TRUNCATED cuando se borra la cadena entera', () => {
      const snapshot = headOf(buildChain(4));

      const audit = auditPatientChain(PATIENT_ID, [], snapshot);

      expect(audit).toMatchObject({
        ok: false,
        failure: { sequenceNumber: 0, reason: 'TAIL_TRUNCATED' },
      });
    });

    it('HISTORY_REWRITTEN cuando se reescribe la cadena entera y se vuelve a sellar', () => {
      const original = buildChain(6);
      const snapshot = headOf(original);

      // El ataque que la cadena sola no puede ver: se cambia una entrada vieja y
      // se recalculan TODOS los hashes posteriores. La cadena resultante es
      // internamente perfecta.
      const reescrita: ChainEntry[] = [];
      let previousHash = GENESIS_HASH;
      for (let i = 1; i <= 6; i++) {
        const entry = appendEntry(
          entryInput(PATIENT_ID, i, i === 3 ? 999 : 60 + i),
          previousHash,
        );
        reescrita.push(entry);
        previousHash = entry.contentHash;
      }

      expect(auditPatientChain(PATIENT_ID, reescrita, null).ok).toBe(true);

      const audit = auditPatientChain(PATIENT_ID, reescrita, snapshot);

      expect(audit).toMatchObject({
        ok: false,
        failure: {
          sequenceNumber: 6,
          reason: 'HISTORY_REWRITTEN',
          expected: snapshot.headHash,
          found: reescrita[5].contentHash,
        },
      });
    });

    it('HISTORY_REWRITTEN cuando se reescribe la historia y además se agregan entradas nuevas', () => {
      const original = buildChain(4);
      const snapshot = headOf(original);

      // La cadena creció (6 > 4), así que el chequeo de truncado no dispara. Lo
      // que delata es que la entrada que era cabeza —la seq 4— ya no tiene el
      // hash que tenía.
      const reescrita: ChainEntry[] = [];
      let previousHash = GENESIS_HASH;
      for (let i = 1; i <= 6; i++) {
        const entry = appendEntry(
          entryInput(PATIENT_ID, i, i === 2 ? 111 : 60 + i),
          previousHash,
        );
        reescrita.push(entry);
        previousHash = entry.contentHash;
      }

      const audit = auditPatientChain(PATIENT_ID, reescrita, snapshot);

      expect(audit).toMatchObject({
        ok: false,
        failure: { sequenceNumber: 4, reason: 'HISTORY_REWRITTEN' },
      });
    });

    it('no confunde crecimiento legítimo con reescritura', () => {
      const entries = buildChain(9);

      // Snapshot tomado en cada punto intermedio: ninguno debe dar falso
      // positivo contra la cadena que siguió creciendo sobre él.
      for (let corte = 1; corte <= 9; corte++) {
        const snapshot = headOf(entries.slice(0, corte));
        expect(auditPatientChain(PATIENT_ID, entries, snapshot).ok).toBe(true);
      }
    });

    it('audita cada paciente contra su propia cadena', () => {
      const otroPaciente = randomUUID();
      const entries = buildChain(3, otroPaciente);

      expect(auditPatientChain(otroPaciente, entries, null).ok).toBe(true);
      // La misma cadena atribuida a otro paciente no verifica: `patient_id`
      // entra a la preimagen.
      expect(
        auditPatientChain(PATIENT_ID, buildChain(3), headOf(entries)).ok,
      ).toBe(false);
    });
  });
});
