import { renderInAppNotification } from './in-app-notification-text';

/** ENG-69 — el texto de cada aviso, en hora de Argentina y sin "undefined". */
describe('renderInAppNotification', () => {
  const SCHEDULED = '2026-10-23T13:30:00.000Z'; // viernes 10:30 en AR

  it('acceso al MediPass: dice quién entró y qué hacer si no lo reconoce (ENG-177)', () => {
    expect(
      renderInAppNotification('MEDIPASS_ACCESO', {
        consultante: 'Dra. Paula Ferrer',
        matricula: 'MP 12345',
      }),
    ).toEqual({
      title: 'Abrieron tu MediPass',
      body: 'Dra. Paula Ferrer (matrícula MP 12345) abrió tu MediPass con tu código. Si no lo reconocés, cortale el acceso.',
    });
    expect(renderInAppNotification('MEDIPASS_ACCESO', {}).body).toMatch(
      /^Alguien abrió/,
    );
  });

  it('turno pagado: nombra al paciente y la fecha en hora de Argentina', () => {
    expect(
      renderInAppNotification('PAGO_CONFIRMADO', {
        patient: 'Julián Pérez',
        scheduledAt: SCHEDULED,
      }),
    ).toEqual({
      title: 'Turno nuevo confirmado',
      body: 'Julián Pérez reservó y pagó un turno para el viernes, 23 de octubre a las 10:30.',
    });
  });

  it('turno cancelado: dice que el horario quedó libre', () => {
    expect(
      renderInAppNotification('TURNO_CANCELADO', {
        patient: 'Julián Pérez',
        scheduledAt: SCHEDULED,
      }).body,
    ).toBe(
      'Julián Pérez canceló su turno del viernes, 23 de octubre a las 10:30. El horario quedó libre.',
    );
  });

  it('turno reprogramado: dice de qué horario a qué horario (ENG-66)', () => {
    expect(
      renderInAppNotification('TURNO_REPROGRAMADO', {
        patient: 'Julián Pérez',
        previousScheduledAt: SCHEDULED,
        scheduledAt: '2026-10-26T13:30:00.000Z',
      }),
    ).toEqual({
      title: 'Turno reprogramado',
      body: 'Julián Pérez movió su turno del viernes, 23 de octubre a las 10:30 al lunes, 26 de octubre a las 10:30.',
    });
  });

  it('el pago confirmado del lado del paciente (seed de demo) no inventa un nombre', () => {
    expect(
      renderInAppNotification('PAGO_CONFIRMADO', { amount: 16000 }),
    ).toEqual({
      title: 'Pago confirmado',
      body: 'Se acreditó el pago y tu turno quedó confirmado.',
    });
  });

  it('un payload vacío o roto da un texto genérico, nunca "undefined"', () => {
    for (const payload of [
      null,
      undefined,
      'x',
      [],
      { scheduledAt: 'no-es-fecha' },
    ]) {
      const { body } = renderInAppNotification('TURNO_CANCELADO', payload);
      expect(body).toBe(
        'Un paciente canceló su turno. El horario quedó libre.',
      );
    }
  });

  it('mensaje nuevo (ENG-70): nombra a quien escribió, o queda genérico', () => {
    expect(
      renderInAppNotification('NUEVO_MENSAJE', { from: 'Dra. Laura Gómez' }),
    ).toEqual({
      title: 'Mensaje nuevo',
      body: 'Dra. Laura Gómez te escribió.',
    });
    expect(renderInAppNotification('NUEVO_MENSAJE', { from: '  ' }).body).toBe(
      'Tenés un mensaje sin leer.',
    );
  });

  it('un tipo desconocido sale con un texto neutro', () => {
    expect(renderInAppNotification('OTRO', {})).toEqual({
      title: 'Aviso',
      body: 'Tenés un aviso nuevo.',
    });
  });
});
