import { renderInAppNotification } from './in-app-notification-text';
import { noticeDataFromPayload, patientNoticeText } from './patient-notices';

/** 21/11/2026 15:00 en Argentina (18:00 UTC). */
const TURNO = '2026-11-21T18:00:00.000Z';
/** 20/11/2026 15:00 en Argentina. */
const PLAZO = '2026-11-20T18:00:00.000Z';

describe('patientNoticeText (ENG-204)', () => {
  it('turno pagado cancelado: dice quién, cuándo, el motivo, las opciones y el plazo', () => {
    const { title, body } = patientNoticeText('TURNO_CANCELADO_PROFESIONAL', {
      professional: 'Ana Pérez',
      scheduledAt: TURNO,
      reason: 'Tengo un congreso',
      outcome: 'A_REPROGRAMAR',
      deadline: PLAZO,
    });

    expect(title).toBe('Ana Pérez no va a poder atenderte');
    expect(body).toBe(
      'Ana Pérez canceló tu turno del sábado, 21 de noviembre a las 15:00. Motivo: "Tengo un congreso". Elegí otro horario sin volver a pagar o pedí el reembolso del 100 % antes del viernes, 20 de noviembre a las 15:00.',
    );
  });

  it('reserva sin pagar cancelada: aclara que no se cobró nada', () => {
    const { title, body } = patientNoticeText('TURNO_CANCELADO_PROFESIONAL', {
      professional: 'Ana Pérez',
      scheduledAt: TURNO,
      outcome: 'CANCELADO',
    });

    expect(title).toBe('Se canceló tu reserva');
    expect(body).toContain('no se te cobró nada');
    expect(body).not.toContain('Motivo');
  });

  it('reembolso elegido y procesado', () => {
    const { title, body } = patientNoticeText('REEMBOLSO_TOTAL', {
      professional: 'Ana Pérez',
      scheduledAt: TURNO,
      amount: 18000,
      currency: 'ARS',
      cause: 'ELEGIDO',
      refundStatus: 'PROCESADO',
    });

    expect(title).toBe('Te devolvemos el 100 %');
    expect(body).toContain('Pediste el reembolso de tu turno con Ana Pérez');
    expect(body).toContain('te devolvemos $ 18.000 (el 100 %)');
    expect(body).toContain('Puede tardar unos días');
  });

  it('reembolso por plazo vencido y todavía pendiente en MercadoPago', () => {
    const { body } = patientNoticeText('REEMBOLSO_TOTAL', {
      amount: 18000,
      cause: 'VENCIDO',
      refundStatus: 'PENDIENTE',
    });

    expect(body).toContain('Venció el plazo para elegir un horario nuevo');
    expect(body).toContain('Lo estamos procesando');
  });

  it('sin datos sale un texto genérico, nunca "undefined"', () => {
    for (const type of [
      'TURNO_CANCELADO_PROFESIONAL',
      'REEMBOLSO_TOTAL',
    ] as const) {
      const { title, body } = patientNoticeText(type, {});
      expect(`${title} ${body}`).not.toMatch(/undefined|null|NaN/);
    }
  });
});

describe('noticeDataFromPayload', () => {
  it('descarta lo que no tiene la forma esperada', () => {
    expect(
      noticeDataFromPayload({
        professional: '  Ana  ',
        outcome: 'OTRA_COSA',
        cause: 'X',
        amount: '18000',
        reason: '',
      }),
    ).toEqual({
      professional: 'Ana',
      scheduledAt: undefined,
      reason: undefined,
      outcome: undefined,
      deadline: undefined,
      amount: undefined,
      currency: undefined,
      cause: undefined,
      refundStatus: undefined,
    });
  });

  it('tolera un payload que no es objeto', () => {
    expect(noticeDataFromPayload(null).professional).toBeUndefined();
    expect(noticeDataFromPayload(['x']).professional).toBeUndefined();
  });
});

describe('renderInAppNotification con los avisos de ENG-204', () => {
  it('usa el mismo texto que el push y el mail', () => {
    const payload = {
      professional: 'Ana Pérez',
      scheduledAt: TURNO,
      outcome: 'A_REPROGRAMAR',
      deadline: PLAZO,
    };
    expect(
      renderInAppNotification('TURNO_CANCELADO_PROFESIONAL', payload),
    ).toEqual(
      patientNoticeText(
        'TURNO_CANCELADO_PROFESIONAL',
        noticeDataFromPayload(payload),
      ),
    );
    expect(
      renderInAppNotification('REEMBOLSO_TOTAL', { amount: 100 }).title,
    ).toBe('Te devolvemos el 100 %');
  });
});

describe('avisos del ciclo del turno (ENG-208)', () => {
  const base = {
    professional: 'Ana Pérez',
    scheduledAt: '2026-11-23T18:00:00.000Z',
  };

  it('el recordatorio del plazo dice hasta cuándo y qué pasa si no elige', () => {
    const { title, body } = patientNoticeText(
      'PLAZO_REPROGRAMACION_POR_VENCER',
      {
        ...base,
        deadline: '2026-11-23T12:00:00.000Z',
      },
    );
    expect(title).toBe('Elegí qué hacer con tu turno');
    expect(body).toContain('hasta el lunes, 23 de noviembre a las 09:00');
    expect(body).toContain('te devolvemos el 100 % igual');
  });

  it('el comprobante de la cancelación dice cuánto se devuelve y el porcentaje', () => {
    const { title, body } = patientNoticeText('CANCELACION_CONFIRMADA', {
      ...base,
      percent: 50,
      amount: 7500,
      refundStatus: 'PROCESADO',
    });
    expect(title).toBe('Cancelaste tu turno');
    expect(body).toContain('Te devolvemos $ 7.500 (el 50 %)');
    expect(body).toContain('Puede tardar unos días');
  });

  it('sin reembolso, el comprobante lo explica por la política', () => {
    expect(
      patientNoticeText('CANCELACION_CONFIRMADA', { ...base, percent: 0 }).body,
    ).toContain('no prevé reembolso');
  });

  it('un reembolso que quedó pendiente avisa si está en proceso o si falló', () => {
    expect(
      patientNoticeText('CANCELACION_CONFIRMADA', {
        ...base,
        percent: 100,
        amount: 15000,
        refundStatus: 'PENDIENTE',
      }).body,
    ).toContain('Lo estamos procesando');
    expect(
      patientNoticeText('CANCELACION_CONFIRMADA', {
        ...base,
        percent: 100,
        amount: 15000,
        refundStatus: 'RECHAZADO',
      }).body,
    ).toContain('escribinos y lo resolvemos');
  });

  it('el resultado de un reembolso pendiente: acreditado o con problema', () => {
    expect(
      patientNoticeText('REEMBOLSO_ACTUALIZADO', {
        ...base,
        amount: 15000,
        refundStatus: 'PROCESADO',
      }),
    ).toMatchObject({ title: 'Se acreditó tu reembolso' });
    expect(
      patientNoticeText('REEMBOLSO_ACTUALIZADO', {
        ...base,
        amount: 15000,
        refundStatus: 'RECHAZADO',
      }),
    ).toMatchObject({ title: 'Hubo un problema con tu reembolso' });
  });

  it('la campanita usa los mismos textos que el mail y el push', () => {
    expect(
      renderInAppNotification('REEMBOLSO_ACTUALIZADO', {
        ...base,
        refundStatus: 'RECHAZADO',
      }).title,
    ).toBe('Hubo un problema con tu reembolso');
  });
});

describe('turnos que no se realizaron (ENG-237)', () => {
  const base = {
    professional: 'Ana Pérez',
    scheduledAt: '2026-11-23T18:00:00.000Z',
    outcome: 'A_REPROGRAMAR' as const,
    deadline: '2026-11-25T18:00:00.000Z',
  };

  it('si el profesional no se conectó, no dice "canceló" ni repite un motivo', () => {
    const { title, body } = patientNoticeText('TURNO_CANCELADO_PROFESIONAL', {
      ...base,
      reprogramCause: 'AUSENCIA_PROFESIONAL',
    });
    expect(title).toBe('Tu consulta no se realizó');
    expect(body).toContain('Ana Pérez no se conectó a tu consulta');
    expect(body).toContain('elegí otro horario sin volver a pagar');
    expect(body).not.toContain('canceló');
  });

  it('una falla técnica dice qué pasó, con el motivo del profesional', () => {
    const { title, body } = patientNoticeText('TURNO_CANCELADO_PROFESIONAL', {
      ...base,
      reprogramCause: 'FALLA_TECNICA',
      reason: 'Se cortó la videollamada.',
    });
    expect(title).toBe('Tu consulta no se pudo completar');
    expect(body).toContain('falla técnica');
    expect(body).toContain('Motivo: "Se cortó la videollamada."');
  });

  it('la causa se lee del payload guardado, y una desconocida se ignora', () => {
    expect(
      noticeDataFromPayload({ reprogramCause: 'FALLA_TECNICA' }).reprogramCause,
    ).toBe('FALLA_TECNICA');
    expect(
      noticeDataFromPayload({ reprogramCause: 'OTRA' }).reprogramCause,
    ).toBeUndefined();
  });
});
