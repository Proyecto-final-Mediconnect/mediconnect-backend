import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AppointmentPaymentService } from './appointment-payment.service';
import { MercadoPagoApiError, MercadoPagoService } from './mercadopago.service';

/**
 * Cobro del turno (ENG-63).
 *
 * Lo que se verifica acá es el contrato con ENG-64 —qué `external_reference` y
 * qué monto quedan guardados— y las reglas que impiden cobrar dos veces o cobrar
 * lo que no corresponde. Cada caso que rechaza tiene además un assert de que
 * **no se llamó a MercadoPago**: una preferencia creada de más queda colgada en
 * el panel del proveedor.
 */

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';
const APPOINTMENT = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const MINUTE = 60 * 1000;

type Row = {
  id: string;
  patient_id: string;
  professional_id: string;
  price: string | number;
  status: string;
  scheduled_at: string;
  created_at: string;
};

function appointmentRow(overrides: Partial<Row> = {}): Row {
  return {
    id: APPOINTMENT,
    patient_id: PATIENT,
    professional_id: PROFESSIONAL,
    price: '15000.00',
    status: 'RESERVADO_SIN_PAGAR',
    scheduled_at: '2026-10-20T13:00:00.000Z',
    // Recién reservado: la retención de ENG-101 vence a NOW + 15 min.
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

describe('AppointmentPaymentService', () => {
  let service: AppointmentPaymentService;
  let mercadopago: {
    isConfigured: jest.Mock;
    isSandbox: jest.Mock;
    createPreference: jest.Mock;
    getPreference: jest.Mock;
    expirePreference: jest.Mock;
    updateBackUrls: jest.Mock;
  };
  let prisma: {
    payment: { findUnique: jest.Mock; upsert: jest.Mock };
    professional: { findUnique: jest.Mock };
  };
  let env: Record<string, string | undefined>;

  function build(row: Row | null, error: unknown = null) {
    const supabase = {
      getClientForToken: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: row, error }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseService;

    mercadopago = {
      isConfigured: jest.fn().mockReturnValue(true),
      isSandbox: jest.fn().mockReturnValue(true),
      createPreference: jest.fn().mockResolvedValue({
        id: 'pref-1',
        initPoint: 'https://mp/checkout/prod',
        sandboxInitPoint: 'https://mp/checkout/sandbox',
        externalReference: APPOINTMENT,
        expiresAt: new Date(NOW.getTime() + 15 * MINUTE),
      }),
      getPreference: jest.fn(),
      expirePreference: jest.fn().mockResolvedValue(undefined),
      updateBackUrls: jest.fn().mockResolvedValue(undefined),
    };

    prisma = {
      payment: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest
          .fn()
          .mockImplementation(
            ({ create }: { create: Record<string, unknown> }) =>
              Promise.resolve({
                status: create?.status ?? 'PENDIENTE',
                amount: create?.amount ?? 15000,
                currency: create?.currency ?? 'ARS',
              }),
          ),
      },
      professional: {
        findUnique: jest.fn().mockResolvedValue({
          first_name: 'Ana',
          last_name: 'Gómez',
          currency: 'ARS',
        }),
      },
    };

    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;

    service = new AppointmentPaymentService(
      prisma as unknown as PrismaService,
      supabase,
      mercadopago as unknown as MercadoPagoService,
      config,
    );
  }

  beforeEach(() => {
    env = {
      MERCADOPAGO_NOTIFICATION_URL: 'https://api.test/payments/webhook',
      MERCADOPAGO_WEBHOOK_SECRET: 'secreto',
      WEB_ORIGIN: 'https://app.test',
    };
    build(appointmentRow());
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('el contrato con ENG-64', () => {
    it('manda el id del turno como external_reference', async () => {
      // Si esto cambia, el webhook no encuentra el Payment y el turno queda
      // pago pero sin confirmar.
      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      expect(mercadopago.createPreference).toHaveBeenCalledWith(
        expect.objectContaining({ externalReference: APPOINTMENT }),
      );
    });

    it('guarda el monto congelado del turno, no el precio del perfil', async () => {
      // El webhook compara lo cobrado contra esta fila. ENG-54 congela el precio
      // al reservar justamente para que un cambio posterior no lo altere.
      prisma.professional.findUnique.mockResolvedValue({
        first_name: 'Ana',
        last_name: 'Gómez',
        currency: 'ARS',
      });
      build(appointmentRow({ price: '15000.00' }));

      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      expect(prisma.payment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ amount: 15000, currency: 'ARS' }),
        }),
      );
    });

    it('la fila nace en PENDIENTE', async () => {
      const link = await service.createCheckout(
        'jwt',
        PATIENT,
        APPOINTMENT,
        NOW,
      );

      expect(link.status).toBe('PENDIENTE');
    });

    it('manda la URL de notificación del webhook', async () => {
      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      expect(mercadopago.createPreference).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationUrl: 'https://api.test/payments/webhook',
        }),
      );
    });
  });

  describe('idempotencia', () => {
    it('la primera vez crea la preferencia con una clave atada al turno', async () => {
      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      expect(mercadopago.getPreference).not.toHaveBeenCalled();
      expect(mercadopago.createPreference).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: `${APPOINTMENT}:inicial` }),
      );
    });

    it('con una preferencia PENDIENTE vigente la reutiliza y no crea otra', async () => {
      // Volver atrás en el navegador y reintentar es normal. Lo que no puede
      // pasar es que se cree una segunda preferencia: la primera seguiría viva
      // y se podría pagar desde otra pestaña.
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'PENDIENTE',
        mercadopago_preference_id: 'pref-viva',
      });
      mercadopago.getPreference.mockResolvedValue({
        id: 'pref-viva',
        initPoint: 'https://mp/checkout/prod-viva',
        sandboxInitPoint: 'https://mp/checkout/sandbox-viva',
        externalReference: APPOINTMENT,
        expiresAt: new Date(NOW.getTime() + 10 * MINUTE),
        backUrlSuccess: `https://app.test/turnos/${APPOINTMENT}/pago?resultado=exito`,
      });

      const link = await service.createCheckout(
        'jwt',
        PATIENT,
        APPOINTMENT,
        NOW,
      );

      expect(mercadopago.getPreference).toHaveBeenCalledWith('pref-viva');
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
      // Misma punta que la vez anterior: no hay nada que cambiarle.
      expect(mercadopago.updateBackUrls).not.toHaveBeenCalled();
      expect(link.checkoutUrl).toBe('https://mp/checkout/sandbox-viva');
      expect(prisma.payment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            mercadopago_preference_id: 'pref-viva',
          }),
        }),
      );
    });

    it('si la guardada está por vencer crea otra, con una clave nueva', async () => {
      // Con la misma clave MercadoPago podría devolver la preferencia muerta.
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'PENDIENTE',
        mercadopago_preference_id: 'pref-vieja',
      });
      mercadopago.getPreference.mockResolvedValue({
        id: 'pref-vieja',
        initPoint: 'x',
        sandboxInitPoint: 'x',
        externalReference: APPOINTMENT,
        expiresAt: new Date(NOW.getTime() + 30 * 1000),
      });

      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      expect(mercadopago.createPreference).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `${APPOINTMENT}:pref-vieja`,
        }),
      );
    });

    it('si MercadoPago ya no conoce la guardada (404) crea otra', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'PENDIENTE',
        mercadopago_preference_id: 'pref-ajena',
      });
      mercadopago.getPreference.mockRejectedValue(
        new MercadoPagoApiError(404, 502, 'no existe'),
      );

      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      expect(mercadopago.createPreference).toHaveBeenCalledTimes(1);
    });

    it('un reintento después de un RECHAZADO vuelve la fila a PENDIENTE', async () => {
      // Si no, la pantalla recibiría un link nuevo junto con el rechazo viejo.
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'RECHAZADO',
        mercadopago_preference_id: null,
      });
      prisma.payment.upsert.mockImplementation(
        ({ update }: { update: Record<string, unknown> }) =>
          Promise.resolve({
            status: update.status,
            amount: 15000,
            currency: 'ARS',
          }),
      );

      const link = await service.createCheckout(
        'jwt',
        PATIENT,
        APPOINTMENT,
        NOW,
      );

      expect(link.status).toBe('PENDIENTE');
      expect(prisma.payment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          // Nunca pisa un pago que el webhook cerró entre la lectura y esta
          // escritura.
          where: {
            appointment_id: APPOINTMENT,
            status: { notIn: ['APROBADO', 'REEMBOLSADO'] },
          },
          update: { mercadopago_preference_id: 'pref-1', status: 'PENDIENTE' },
        }),
      );
    });

    it('si el webhook aprobó el pago en el medio, 409 en vez de pisarlo', async () => {
      prisma.payment.upsert.mockRejectedValue({ code: 'P2002' });

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toThrow(ConflictException);
    });

    it.each(['APROBADO', 'REEMBOLSADO'])(
      'rechaza si el pago ya está en %s, y no toca MercadoPago',
      async (status) => {
        prisma.payment.findUnique.mockResolvedValue({ id: 'pay-1', status });

        await expect(
          service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
        ).rejects.toThrow(ConflictException);
        expect(mercadopago.createPreference).not.toHaveBeenCalled();
      },
    );
  });

  describe('vencimiento del link', () => {
    it('vence a los 15 minutos', async () => {
      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      expect(mercadopago.createPreference).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: new Date(NOW.getTime() + 15 * MINUTE),
        }),
      );
    });

    it('si el turno empieza antes, vence al empezar el turno', async () => {
      const start = new Date(NOW.getTime() + 5 * MINUTE);
      build(appointmentRow({ scheduled_at: start.toISOString() }));

      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      expect(mercadopago.createPreference).toHaveBeenCalledWith(
        expect.objectContaining({ expiresAt: start }),
      );
    });

    it('nunca vive más que la retención de la reserva (ENG-101)', async () => {
      // Reservado hace 14 minutos: la retención vence en 1. Si el link viviera
      // los 15 completos, el paciente podría pagar un turno ya liberado.
      const reservedAt = new Date(NOW.getTime() - 14 * MINUTE);
      build(appointmentRow({ created_at: reservedAt.toISOString() }));

      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      expect(mercadopago.createPreference).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: new Date(reservedAt.getTime() + 15 * MINUTE),
        }),
      );
    });

    it('con la retención vencida no se paga, aunque el job no la haya liberado', async () => {
      // El job corre cada 5 minutos: en ese rato el turno sigue
      // RESERVADO_SIN_PAGAR pero ya no es del paciente.
      build(
        appointmentRow({
          created_at: new Date(NOW.getTime() - 15 * MINUTE).toISOString(),
        }),
      );

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toThrow(/venció/);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });

    it('un turno que ya pasó no se paga', async () => {
      // ENG-101 no libera los turnos que ya empezaron: sigue en
      // RESERVADO_SIN_PAGAR, y el webhook lo pasaría a CONFIRMADO.
      build(appointmentRow({ scheduled_at: '2026-10-14T11:00:00.000Z' }));

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toThrow(/ya pasó/);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });
  });

  describe('falla de MercadoPago', () => {
    it('propaga el error y no deja fila en payments', async () => {
      // El turno sigue RESERVADO_SIN_PAGAR y el paciente puede reintentar.
      mercadopago.createPreference.mockRejectedValue(
        new MercadoPagoApiError(
          503,
          502,
          'MercadoPago rechazó la operación (HTTP 503).',
        ),
      );

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toBeInstanceOf(MercadoPagoApiError);
      expect(prisma.payment.upsert).not.toHaveBeenCalled();
    });
  });

  describe('expireCheckout', () => {
    it('vence la preferencia de un pago todavía abierto', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        status: 'PENDIENTE',
        mercadopago_preference_id: 'pref-1',
      });

      await service.expireCheckout(APPOINTMENT, NOW);

      expect(mercadopago.expirePreference).toHaveBeenCalledWith('pref-1', NOW);
    });

    it.each(['APROBADO', 'REEMBOLSADO'])(
      'no toca un pago %s',
      async (status) => {
        prisma.payment.findUnique.mockResolvedValue({
          status,
          mercadopago_preference_id: 'pref-1',
        });

        await service.expireCheckout(APPOINTMENT, NOW);

        expect(mercadopago.expirePreference).not.toHaveBeenCalled();
      },
    );

    it('sin pago no hace nada', async () => {
      await service.expireCheckout(APPOINTMENT, NOW);

      expect(mercadopago.expirePreference).not.toHaveBeenCalled();
    });

    it('si MercadoPago falla no tira: la cancelación ya pasó', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        status: 'PENDIENTE',
        mercadopago_preference_id: 'pref-1',
      });
      mercadopago.expirePreference.mockRejectedValue(new Error('timeout'));

      await expect(
        service.expireCheckout(APPOINTMENT, NOW),
      ).resolves.toBeUndefined();
    });
  });

  describe('quién puede pagar', () => {
    it('el paciente del turno sí', async () => {
      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).resolves.toMatchObject({ appointmentId: APPOINTMENT });
    });

    it('el profesional no, y no se crea ninguna preferencia', async () => {
      await expect(
        service.createCheckout('jwt', PROFESSIONAL, APPOINTMENT, NOW),
      ).rejects.toThrow(ForbiddenException);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });

    it('un turno que RLS no devuelve da 404', async () => {
      build(null);

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('estado del turno', () => {
    it('un turno CONFIRMADO ya está pago', async () => {
      build(appointmentRow({ status: 'CONFIRMADO' }));

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toThrow(/ya está pago/);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });

    it.each(['CANCELADO', 'LIBERADO', 'COMPLETADO', 'NO_ASISTIO'])(
      'rechaza un turno en %s',
      async (status) => {
        build(appointmentRow({ status }));

        await expect(
          service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
        ).rejects.toThrow(ConflictException);
        expect(mercadopago.createPreference).not.toHaveBeenCalled();
      },
    );
  });

  describe('configuración faltante', () => {
    it('sin credenciales de MercadoPago devuelve 503, no un error del proveedor', async () => {
      build(appointmentRow());
      mercadopago.isConfigured.mockReturnValue(false);

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('sin URL de notificación NO cobra', async () => {
      // Cobrar sin webhook configurado es cobrar y no confirmar nunca el turno.
      env.MERCADOPAGO_NOTIFICATION_URL = undefined;

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });

    it('sin secreto del webhook NO cobra', async () => {
      // El webhook descartaría todas las notificaciones: mismo caso que sin URL.
      env.MERCADOPAGO_WEBHOOK_SECRET = undefined;

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });

    it('sin WEB_ORIGIN en producción NO cobra', async () => {
      // El paciente volvería de pagar a un localhost que no existe.
      env.WEB_ORIGIN = undefined;
      env.NODE_ENV = 'production';

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });

    it('sin WEB_ORIGIN en desarrollo vuelve a localhost', async () => {
      env.WEB_ORIGIN = undefined;

      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      const { backUrls } = mercadopago.createPreference.mock.calls[0][0] as {
        backUrls: Record<string, string>;
      };
      expect(backUrls.success).toMatch(/^http:\/\/localhost:5173\//);
    });

    it('un WEB_ORIGIN que es una lista NO cobra', async () => {
      env.WEB_ORIGIN = 'https://app.test,https://otra.test';

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });

    it('un turno con precio no cobrable no llega a MercadoPago', async () => {
      build(appointmentRow({ price: '0' }));

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW),
      ).rejects.toThrow(ConflictException);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });
  });

  describe('sandbox', () => {
    it('en sandbox devuelve el init point de prueba y lo avisa', async () => {
      const link = await service.createCheckout(
        'jwt',
        PATIENT,
        APPOINTMENT,
        NOW,
      );

      expect(link.checkoutUrl).toBe('https://mp/checkout/sandbox');
      expect(link.sandbox).toBe(true);
    });

    it('en producción devuelve el init point real', async () => {
      mercadopago.isSandbox.mockReturnValue(false);

      const link = await service.createCheckout(
        'jwt',
        PATIENT,
        APPOINTMENT,
        NOW,
      );

      expect(link.checkoutUrl).toBe('https://mp/checkout/prod');
      expect(link.sandbox).toBe(false);
    });
  });

  describe('back urls', () => {
    it('las tres vuelven a la pantalla de pago del turno', async () => {
      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      const { backUrls } = mercadopago.createPreference.mock.calls[0][0] as {
        backUrls: Record<string, string>;
      };
      expect(backUrls.success).toBe(
        `https://app.test/turnos/${APPOINTMENT}/pago?resultado=exito`,
      );
      expect(backUrls.failure).toContain('resultado=fallo');
      expect(backUrls.pending).toContain('resultado=pendiente');
    });
  });

  describe('readStatus', () => {
    it('sin pago todavía devuelve SIN_INICIAR, no un error', async () => {
      await expect(
        service.readStatus('jwt', PATIENT, APPOINTMENT),
      ).resolves.toMatchObject({ status: 'SIN_INICIAR' });
    });

    it('devuelve lo que escribió el webhook', async () => {
      prisma.payment.findUnique.mockResolvedValue({ status: 'APROBADO' });

      await expect(
        service.readStatus('jwt', PATIENT, APPOINTMENT),
      ).resolves.toMatchObject({
        status: 'APROBADO',
        appointmentStatus: 'RESERVADO_SIN_PAGAR',
      });
    });

    it('el profesional no puede consultarlo', async () => {
      await expect(
        service.readStatus('jwt', PROFESSIONAL, APPOINTMENT),
      ).rejects.toThrow(ForbiddenException);
    });
  });
  describe('vuelta a la app (ENG-172)', () => {
    const APP_URLS = {
      success: `mediconnect://pago/${APPOINTMENT}?resultado=exito`,
      failure: `mediconnect://pago/${APPOINTMENT}?resultado=fallo`,
      pending: `mediconnect://pago/${APPOINTMENT}?resultado=pendiente`,
    };

    function preferenciaViva(backUrlSuccess: string) {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'PENDIENTE',
        mercadopago_preference_id: 'pref-viva',
      });
      mercadopago.getPreference.mockResolvedValue({
        id: 'pref-viva',
        initPoint: 'https://mp/checkout/prod-viva',
        sandboxInitPoint: 'https://mp/checkout/sandbox-viva',
        externalReference: APPOINTMENT,
        expiresAt: new Date(NOW.getTime() + 10 * MINUTE),
        backUrlSuccess,
      });
    }

    it('desde la app, los back_urls abren la app', async () => {
      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW, 'app');

      expect(mercadopago.createPreference).toHaveBeenCalledWith(
        expect.objectContaining({ backUrls: APP_URLS }),
      );
    });

    it('sin origen sigue volviendo a la web', async () => {
      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW);

      expect(mercadopago.createPreference).toHaveBeenCalledWith(
        expect.objectContaining({
          backUrls: {
            success: `https://app.test/turnos/${APPOINTMENT}/pago?resultado=exito`,
            failure: `https://app.test/turnos/${APPOINTMENT}/pago?resultado=fallo`,
            pending: `https://app.test/turnos/${APPOINTMENT}/pago?resultado=pendiente`,
          },
        }),
      );
    });

    it('la app sin WEB_ORIGIN en producción igual cobra: no lo necesita', async () => {
      env.NODE_ENV = 'production';
      env.WEB_ORIGIN = undefined;

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW, 'app'),
      ).resolves.toMatchObject({ appointmentId: APPOINTMENT });
    });

    it('empezado en la web y seguido en la app: la misma preferencia, que ahora vuelve a la app', async () => {
      // Crear otra dejaría dos links pagables para el mismo turno.
      preferenciaViva(
        `https://app.test/turnos/${APPOINTMENT}/pago?resultado=exito`,
      );

      const link = await service.createCheckout(
        'jwt',
        PATIENT,
        APPOINTMENT,
        NOW,
        'app',
      );

      expect(mercadopago.createPreference).not.toHaveBeenCalled();
      expect(mercadopago.updateBackUrls).toHaveBeenCalledWith(
        'pref-viva',
        APP_URLS,
      );
      expect(link.checkoutUrl).toBe('https://mp/checkout/sandbox-viva');
    });

    it('al revés también: de la app a la web', async () => {
      preferenciaViva(APP_URLS.success);

      await service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW, 'web');

      expect(mercadopago.updateBackUrls).toHaveBeenCalledWith(
        'pref-viva',
        expect.objectContaining({
          success: `https://app.test/turnos/${APPOINTMENT}/pago?resultado=exito`,
        }),
      );
    });

    it('si MercadoPago no deja cambiarlos, no devuelve un link que vuelve al lugar equivocado', async () => {
      preferenciaViva(
        `https://app.test/turnos/${APPOINTMENT}/pago?resultado=exito`,
      );
      mercadopago.updateBackUrls.mockRejectedValue(new Error('mp caído'));

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT, NOW, 'app'),
      ).rejects.toThrow('mp caído');
      expect(prisma.payment.upsert).not.toHaveBeenCalled();
    });
  });
});
