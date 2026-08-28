/**
 * ENG-85 — Tests de la alerta a Slack.
 *
 * El test que más importa es el de no-filtración: Slack es un canal con
 * retención y exportable, y lo que se manda desde acá sale de la tabla de
 * Historia Clínica. Que no se cuele contenido clínico no puede depender de que
 * alguien se acuerde al editar el mensaje.
 */
import { Logger } from '@nestjs/common';
import type { IntegrityFailure } from './chain-audit';
import { SlackIntegrityAlerter } from './integrity-alerter';
import type { IntegrityRunResult } from './integrity.types';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/secreto';

function failure(n: number): IntegrityFailure {
  return {
    patientId: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`,
    sequenceNumber: n,
    reason: 'CONTENT_TAMPERED',
    expected: 'a'.repeat(64),
    found: 'b'.repeat(64),
  };
}

function result(failures: IntegrityFailure[]): IntegrityRunResult {
  return {
    checkId: '9f3c1d2e-0000-4000-8000-000000000001',
    status: 'INCONSISTENT',
    patientsChecked: 120,
    entriesChecked: 4800,
    durationMs: 210,
    failures,
  };
}

/** Cuerpo JSON del `fetch` que hizo el alertador. */
function sentBody(fetchMock: jest.Mock): { text: string; blocks: unknown[] } {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as { text: string; blocks: unknown[] };
}

describe('SlackIntegrityAlerter', () => {
  let fetchMock: jest.Mock;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;
  });

  it('publica la alerta en el webhook con el detalle de las inconsistencias', async () => {
    const alerter = new SlackIntegrityAlerter(WEBHOOK, 'https://gh/run/1');

    const delivered = await alerter.inconsistencyDetected(result([failure(3)]));

    expect(delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      WEBHOOK,
      expect.objectContaining({ method: 'POST' }),
    );

    const body = sentBody(fetchMock);
    // `text` es el fallback de la notificación push: sin él Slack muestra
    // "This content can't be displayed".
    expect(body.text).toContain('Integridad de la Historia Clínica');
    expect(JSON.stringify(body)).toContain(failure(3).patientId);
    expect(JSON.stringify(body)).toContain('CONTENT_TAMPERED');
    expect(JSON.stringify(body)).toContain('https://gh/run/1');
    expect(JSON.stringify(body)).toContain(
      '9f3c1d2e-0000-4000-8000-000000000001',
    );
  });

  it('no manda contenido clínico ni PII aunque venga colgado del objeto de falla', async () => {
    const alerter = new SlackIntegrityAlerter(WEBHOOK);
    // El mensaje se arma campo por campo, no serializando la falla entera. Este
    // objeto simula lo que pasaría si algún día alguien enriquece
    // `IntegrityFailure` con datos de la entrada: no tiene que llegar a Slack.
    const contaminada = {
      ...failure(1),
      professionalId: '22222222-2222-4222-8222-222222222222',
      content: { resourceType: 'Observation', diagnostico: 'HIV positivo' },
      patientEmail: 'paciente@ejemplo.com',
      dni: '30111222',
    } as unknown as IntegrityFailure;

    await alerter.inconsistencyDetected(result([contaminada]));

    const payload = JSON.stringify(sentBody(fetchMock));
    for (const prohibido of [
      'resourceType',
      'Observation',
      'HIV',
      'diagnostico',
      '22222222-2222-4222-8222-222222222222',
      'paciente@ejemplo.com',
      '30111222',
    ]) {
      expect(payload).not.toContain(prohibido);
    }
    // Lo que sí tiene que estar: lo mínimo para investigar.
    expect(payload).toContain(failure(1).patientId);
  });

  it('lista como mucho 10 inconsistencias y avisa cuántas quedaron afuera', async () => {
    const alerter = new SlackIntegrityAlerter(WEBHOOK);
    const failures = Array.from({ length: 14 }, (_, i) => failure(i + 1));

    await alerter.inconsistencyDetected(result(failures));

    const payload = JSON.stringify(sentBody(fetchMock));
    expect(payload).toContain(failures[9].patientId);
    expect(payload).not.toContain(failures[10].patientId);
    expect(payload).toContain('4 más');
  });

  it('queda inactivo y lo dice cuando no hay webhook configurado', async () => {
    const alerter = new SlackIntegrityAlerter(undefined);

    const delivered = await alerter.inconsistencyDetected(result([failure(1)]));

    expect(delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no explota si Slack rechaza el mensaje', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const alerter = new SlackIntegrityAlerter(WEBHOOK);

    await expect(
      alerter.inconsistencyDetected(result([failure(1)])),
    ).resolves.toBe(false);
  });

  it('no explota si el webhook no responde', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    const alerter = new SlackIntegrityAlerter(WEBHOOK);

    await expect(
      alerter.inconsistencyDetected(result([failure(1)])),
    ).resolves.toBe(false);
  });

  describe('runFailed', () => {
    it('avisa que la integridad NO quedó verificada', async () => {
      const alerter = new SlackIntegrityAlerter(WEBHOOK);

      await alerter.runFailed(new Error('connect ECONNREFUSED'));

      const payload = JSON.stringify(sentBody(fetchMock));
      expect(payload).toContain('no pudo correr');
      expect(payload).toContain('connect ECONNREFUSED');
      expect(payload).toContain('no quedó verificada');
    });

    it('manda el mensaje del error pero no el stack', async () => {
      const alerter = new SlackIntegrityAlerter(WEBHOOK);
      const error = new Error('fallo raro');
      error.stack =
        'Error: fallo raro\n  at Connection (postgresql://user:pass@host/db)';

      await alerter.runFailed(error);

      const payload = JSON.stringify(sentBody(fetchMock));
      expect(payload).toContain('fallo raro');
      // Un stack puede arrastrar la connection string al canal.
      expect(payload).not.toContain('postgresql://');
      expect(payload).not.toContain('at Connection');
    });
  });
});
