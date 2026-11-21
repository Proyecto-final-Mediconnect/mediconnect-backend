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
