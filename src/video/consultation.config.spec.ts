import {
  consultationRoomProperties,
  JOIN_GRACE_MINUTES_AFTER,
  JOIN_OPENS_MINUTES_BEFORE,
  joinWindowFor,
} from './consultation.config';

/**
 * La ventana de ingreso es el criterio de aceptación de ENG-56, así que se testea
 * en los bordes exactos y no "más o menos": un minuto de más o de menos acá es la
 * diferencia entre poder entrar a la consulta y no poder.
 */
describe('joinWindowFor', () => {
  const scheduledAt = new Date('2026-08-27T15:00:00.000Z');
  const DURATION = 30;

  it('abre 10 minutos antes del horario del turno', () => {
    expect(joinWindowFor(scheduledAt, DURATION).opensAt.toISOString()).toBe(
      '2026-08-27T14:50:00.000Z',
    );
    expect(JOIN_OPENS_MINUTES_BEFORE).toBe(10);
  });

  it('cierra al terminar el turno más la tolerancia', () => {
    // 15:00 + 30 min de turno + 15 de tolerancia.
    expect(joinWindowFor(scheduledAt, DURATION).closesAt.toISOString()).toBe(
      '2026-08-27T15:45:00.000Z',
    );
    expect(JOIN_GRACE_MINUTES_AFTER).toBe(15);
  });

  it('la ventana se estira con la duración del turno', () => {
    const corto = joinWindowFor(scheduledAt, 15).closesAt.getTime();
    const largo = joinWindowFor(scheduledAt, 60).closesAt.getTime();

    expect(largo - corto).toBe(45 * 60_000);
  });

  it('el momento de apertura está incluido, y el anterior no', () => {
    const { opensAt } = joinWindowFor(scheduledAt, DURATION);
    const unMsAntes = new Date(opensAt.getTime() - 1);

    expect(unMsAntes < opensAt).toBe(true);
    expect(opensAt < opensAt).toBe(false);
  });
});

describe('consultationRoomProperties', () => {
  const EXP = 1_800_000_000;

  it('cierra la sala y expulsa a todos al expirar', () => {
    const props = consultationRoomProperties(EXP, 'off');

    expect(props.exp).toBe(EXP);
    // Sin `eject_at_room_exp`, `exp` solo impide entrar: los que ya están adentro
    // siguen consumiendo minutos facturables.
    expect(props.eject_at_room_exp).toBe(true);
  });

  it('limita la sala a dos participantes', () => {
    expect(consultationRoomProperties(EXP, 'off').max_participants).toBe(2);
  });

  it('apaga el chat del Prebuilt', () => {
    // El chat de la sala es efímero: lo que se escriba ahí no queda en la
    // historia clínica. El chat persistente del producto es EP-08.
    expect(consultationRoomProperties(EXP, 'off').enable_chat).toBe(false);
  });

  it('deja la grabación apagada por defecto', () => {
    expect(consultationRoomProperties(EXP, 'off').enable_recording).toBe(false);
  });

  it('pide grabación de solo audio cuando el entorno la habilita', () => {
    expect(
      consultationRoomProperties(EXP, 'cloud-audio-only').enable_recording,
    ).toBe('cloud-audio-only');
  });
});
