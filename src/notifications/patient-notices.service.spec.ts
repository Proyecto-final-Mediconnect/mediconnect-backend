import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { EmailService } from './email.service';
import {
  APPOINTMENTS_CHANNEL_ID,
  PatientNoticesService,
} from './patient-notices.service';
import type { PushService } from './push.service';

const APPOINTMENT = '44444444-4444-4444-8444-444444444444';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-21T12:00:00.000Z');
const CANCELLED_AT = new Date('2026-11-21T11:59:00.000Z');

function appointment(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT,
    patient_id: PATIENT,
    scheduled_at: new Date('2026-11-23T18:00:00.000Z'),
    cancellation_reason: 'Tengo un congreso ese día.',
    cancelled_at: CANCELLED_AT,
    reprogram_deadline: new Date('2026-11-23T12:00:00.000Z'),
    professional: { first_name: 'Ana', last_name: 'Pérez', currency: 'ARS' },
    patient: { first_name: 'Julián', profile: { email: 'julian@test.local' } },
    ...overrides,
  };
}

describe('PatientNoticesService (ENG-204)', () => {
  let service: PatientNoticesService;
  let prisma: {
    appointment: { findUnique: jest.Mock };
    notification: { upsert: jest.Mock };
  };
  let email: { isConfigured: jest.Mock; send: jest.Mock };
  let push: { sendToUser: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma = {
      appointment: { findUnique: jest.fn().mockResolvedValue(appointment()) },
      notification: { upsert: jest.fn().mockResolvedValue({}) },
    };
    email = {
      isConfigured: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue('email-1'),
    };
    push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: (key: string) =>
        key === 'WEB_ORIGIN' ? 'https://mediconnect.test' : undefined,
    } as unknown as ConfigService;
    service = new PatientNoticesService(
      prisma as unknown as PrismaService,
      email as unknown as EmailService,
      push as unknown as PushService,
      config,
    );
  });

  describe('professionalCancelled', () => {
    it('deja el aviso in-app con motivo, plazo y resultado; un repetido lo reemplaza sin leer', async () => {
      await service.professionalCancelled(APPOINTMENT, 'A_REPROGRAMAR', NOW);

      const inApp = prisma.notification.upsert.mock.calls.find(
        ([args]) => args.where.appointment_id_type_channel.channel === 'IN_APP',
      )?.[0];
      expect(inApp.where.appointment_id_type_channel).toEqual({
        appointment_id: APPOINTMENT,
        type: 'TURNO_CANCELADO_PROFESIONAL',
        channel: 'IN_APP',
      });
      expect(inApp.create).toMatchObject({
        user_id: PATIENT,
        payload: {
          appointmentId: APPOINTMENT,
          professional: 'Ana Pérez',
          reason: 'Tengo un congreso ese día.',
          outcome: 'A_REPROGRAMAR',
          deadline: '2026-11-23T12:00:00.000Z',
        },
      });
      expect(inApp.update).toMatchObject({ read_at: null, sent_at: NOW });
    });

    it('el push va al canal de turnos y no lleva el motivo', async () => {
      await service.professionalCancelled(APPOINTMENT, 'A_REPROGRAMAR', NOW);

      expect(push.sendToUser).toHaveBeenCalledWith(PATIENT, {
        title: 'Cambió tu turno',
        body: expect.any(String),
        data: {
          tipo: 'TURNO_CANCELADO_PROFESIONAL',
          appointmentId: APPOINTMENT,
        },
        channelId: APPOINTMENTS_CHANNEL_ID,
      });
      const { body } = push.sendToUser.mock.calls[0][1];
      expect(body).not.toContain('congreso');
    });

    it('el mail lleva al turno, escapa el HTML y es idempotente por instante de cancelación', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        appointment({ cancellation_reason: '<b>urgencia</b>' }),
      );

      await service.professionalCancelled(APPOINTMENT, 'A_REPROGRAMAR', NOW);

      const mail = email.send.mock.calls[0][0];
      expect(mail.to).toBe('julian@test.local');
      expect(mail.subject).toBe('Ana Pérez no va a poder atenderte');
      expect(mail.html).toContain(
        'https://mediconnect.test/turnos/' + APPOINTMENT,
      );
      expect(mail.html).toContain('&lt;b&gt;urgencia&lt;/b&gt;');
      expect(mail.html).not.toContain('<b>urgencia</b>');
      expect(mail.idempotencyKey).toBe(
        `${APPOINTMENT}:TURNO_CANCELADO_PROFESIONAL:${CANCELLED_AT.getTime()}`,
      );
      expect(prisma.notification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            appointment_id_type_channel: expect.objectContaining({
              channel: 'EMAIL',
            }),
          },
        }),
      );
    });

    it('sin mail configurado no manda mail, pero sí in-app y push', async () => {
      email.isConfigured.mockReturnValue(false);

      await service.professionalCancelled(APPOINTMENT, 'CANCELADO', NOW);

      expect(email.send).not.toHaveBeenCalled();
      expect(push.sendToUser).toHaveBeenCalled();
      expect(prisma.notification.upsert).toHaveBeenCalledTimes(1);
    });

    it('nunca tira: si falla el mail, los otros canales salen igual', async () => {
      email.send.mockRejectedValue(new Error('Resend caído'));
      prisma.notification.upsert.mockRejectedValueOnce(new Error('db'));

      await expect(
        service.professionalCancelled(APPOINTMENT, 'A_REPROGRAMAR', NOW),
      ).resolves.toBeUndefined();
      expect(push.sendToUser).toHaveBeenCalled();
    });

    it('si el turno no existe no hace nada', async () => {
      prisma.appointment.findUnique.mockResolvedValue(null);

      await service.professionalCancelled(APPOINTMENT, 'A_REPROGRAMAR', NOW);

      expect(push.sendToUser).not.toHaveBeenCalled();
      expect(email.send).not.toHaveBeenCalled();
    });

    it('si la lectura falla no tira', async () => {
      prisma.appointment.findUnique.mockRejectedValue(new Error('db'));
      await expect(
        service.professionalCancelled(APPOINTMENT, 'A_REPROGRAMAR', NOW),
      ).resolves.toBeUndefined();
    });
  });

  describe('fullRefund', () => {
    it('informa monto, moneda, causa y estado del reembolso', async () => {
      await service.fullRefund(
        APPOINTMENT,
        { amount: 18000, status: 'PROCESADO', cause: 'VENCIDO' },
        NOW,
      );

      const inApp = prisma.notification.upsert.mock.calls[0][0];
      expect(inApp.create).toMatchObject({
        type: 'REEMBOLSO_TOTAL',
        payload: {
          amount: 18000,
          currency: 'ARS',
          cause: 'VENCIDO',
          refundStatus: 'PROCESADO',
        },
      });
      expect(email.send.mock.calls[0][0].subject).toBe(
        'Te devolvemos el 100 %',
      );
      expect(push.sendToUser.mock.calls[0][1].data.tipo).toBe(
        'REEMBOLSO_TOTAL',
      );
    });
  });
});

describe('PatientNoticesService (ENG-208)', () => {
  let prisma: {
    appointment: { findUnique: jest.Mock };
    notification: { upsert: jest.Mock };
  };
  let email: { isConfigured: jest.Mock; send: jest.Mock };
  let push: { sendToUser: jest.Mock };
  let service: PatientNoticesService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma = {
      appointment: { findUnique: jest.fn().mockResolvedValue(appointment()) },
      notification: { upsert: jest.fn().mockResolvedValue({}) },
    };
    email = {
      isConfigured: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue('email-1'),
    };
    push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    service = new PatientNoticesService(
      prisma as unknown as PrismaService,
      email as unknown as EmailService,
      push as unknown as PushService,
      {
        get: (key: string) =>
          key === 'WEB_ORIGIN' ? 'https://mediconnect.test' : undefined,
      } as unknown as ConfigService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('recordatorio del plazo: campanita, push y mail con el link para elegir', async () => {
    await service.reprogramDeadlineSoon(APPOINTMENT, NOW);

    expect(prisma.notification.upsert.mock.calls[0][0].create).toMatchObject({
      type: 'PLAZO_REPROGRAMACION_POR_VENCER',
      channel: 'IN_APP',
      payload: { deadline: '2026-11-23T12:00:00.000Z' },
    });
    expect(push.sendToUser.mock.calls[0][1]).toMatchObject({
      title: 'Elegí qué hacer con tu turno',
      data: {
        tipo: 'PLAZO_REPROGRAMACION_POR_VENCER',
        appointmentId: APPOINTMENT,
      },
    });
    const mail = email.send.mock.calls[0][0];
    expect(mail.text).toContain('Elegir qué hacer con mi turno');
    expect(mail.idempotencyKey).toBe(
      `${APPOINTMENT}:PLAZO_REPROGRAMACION_POR_VENCER:${CANCELLED_AT.getTime()}`,
    );
  });

  it('el comprobante de la cancelación del paciente no suena en el celular', async () => {
    await service.patientCancelled(
      APPOINTMENT,
      { percent: 50, amount: 7500, status: 'PROCESADO' },
      NOW,
    );

    expect(push.sendToUser).not.toHaveBeenCalled();
    expect(prisma.notification.upsert.mock.calls[0][0].create).toMatchObject({
      type: 'CANCELACION_CONFIRMADA',
      payload: { percent: 50, amount: 7500, refundStatus: 'PROCESADO' },
    });
    expect(email.send.mock.calls[0][0].subject).toBe('Cancelaste tu turno');
  });

  it('el resultado de un reembolso sale una vez por reembolso y estado', async () => {
    await service.refundUpdated(
      APPOINTMENT,
      { refundId: 'ref-9', amount: 15000, status: 'RECHAZADO' },
      NOW,
    );

    expect(email.send.mock.calls[0][0]).toMatchObject({
      subject: 'Hubo un problema con tu reembolso',
      idempotencyKey: `${APPOINTMENT}:REEMBOLSO_ACTUALIZADO:ref-9:RECHAZADO`,
    });
    expect(push.sendToUser.mock.calls[0][1].title).toBe(
      'Problema con tu reembolso',
    );
  });
});
