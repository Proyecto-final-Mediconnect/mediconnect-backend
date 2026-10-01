import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AppointmentPaymentService } from './appointment-payment.service';
import { MercadoPagoService } from './mercadopago.service';

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

type Row = {
  id: string;
  patient_id: string;
  professional_id: string;
  price: string | number;
  status: string;
};

function appointmentRow(overrides: Partial<Row> = {}): Row {
  return {
    id: APPOINTMENT,
    patient_id: PATIENT,
    professional_id: PROFESSIONAL,
    price: '15000.00',
    status: 'RESERVADO_SIN_PAGAR',
    ...overrides,
  };
}

describe('AppointmentPaymentService', () => {
  let service: AppointmentPaymentService;
  let mercadopago: {
    isConfigured: jest.Mock;
    isSandbox: jest.Mock;
    createPreference: jest.Mock;
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
      }),
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
      WEB_ORIGIN: 'https://app.test',
    };
    build(appointmentRow());
  });

  describe('el contrato con ENG-64', () => {
    it('manda el id del turno como external_reference', async () => {
      // Si esto cambia, el webhook no encuentra el Payment y el turno queda
      // pago pero sin confirmar.
      await service.createCheckout('jwt', PATIENT, APPOINTMENT);

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

      await service.createCheckout('jwt', PATIENT, APPOINTMENT);

      expect(prisma.payment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ amount: 15000, currency: 'ARS' }),
        }),
      );
    });

    it('la fila nace en PENDIENTE', async () => {
      const link = await service.createCheckout('jwt', PATIENT, APPOINTMENT);

      expect(link.status).toBe('PENDIENTE');
    });

    it('manda la URL de notificación del webhook', async () => {
      await service.createCheckout('jwt', PATIENT, APPOINTMENT);

      expect(mercadopago.createPreference).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationUrl: 'https://api.test/payments/webhook',
        }),
      );
    });
  });

  describe('idempotencia', () => {
    it('usa el id del turno como clave, así dos clicks no crean dos cobros', async () => {
      await service.createCheckout('jwt', PATIENT, APPOINTMENT);

      expect(mercadopago.createPreference).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: APPOINTMENT }),
      );
    });

    it('con un pago PENDIENTE existente devuelve checkout igual', async () => {
      // Volver atrás en el navegador y reintentar es normal. Lo que no puede
      // pasar es que se cree una segunda preferencia.
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'PENDIENTE',
      });

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT),
      ).resolves.toMatchObject({ appointmentId: APPOINTMENT });
      expect(prisma.payment.upsert).toHaveBeenCalledTimes(1);
    });

    it.each(['APROBADO', 'REEMBOLSADO'])(
      'rechaza si el pago ya está en %s, y no toca MercadoPago',
      async (status) => {
        prisma.payment.findUnique.mockResolvedValue({ id: 'pay-1', status });

        await expect(
          service.createCheckout('jwt', PATIENT, APPOINTMENT),
        ).rejects.toThrow(ConflictException);
        expect(mercadopago.createPreference).not.toHaveBeenCalled();
      },
    );
  });

  describe('quién puede pagar', () => {
    it('el paciente del turno sí', async () => {
      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT),
      ).resolves.toMatchObject({ appointmentId: APPOINTMENT });
    });

    it('el profesional no, y no se crea ninguna preferencia', async () => {
      await expect(
        service.createCheckout('jwt', PROFESSIONAL, APPOINTMENT),
      ).rejects.toThrow(ForbiddenException);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });

    it('un turno que RLS no devuelve da 404', async () => {
      build(null);

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('estado del turno', () => {
    it('un turno CONFIRMADO ya está pago', async () => {
      build(appointmentRow({ status: 'CONFIRMADO' }));

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT),
      ).rejects.toThrow(/ya está pago/);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });

    it.each(['CANCELADO', 'LIBERADO', 'COMPLETADO', 'NO_ASISTIO'])(
      'rechaza un turno en %s',
      async (status) => {
        build(appointmentRow({ status }));

        await expect(
          service.createCheckout('jwt', PATIENT, APPOINTMENT),
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
        service.createCheckout('jwt', PATIENT, APPOINTMENT),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('sin URL de notificación NO cobra', async () => {
      // Cobrar sin webhook configurado es cobrar y no confirmar nunca el turno.
      env.MERCADOPAGO_NOTIFICATION_URL = undefined;

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });

    it('un turno con precio no cobrable no llega a MercadoPago', async () => {
      build(appointmentRow({ price: '0' }));

      await expect(
        service.createCheckout('jwt', PATIENT, APPOINTMENT),
      ).rejects.toThrow(ConflictException);
      expect(mercadopago.createPreference).not.toHaveBeenCalled();
    });
  });

  describe('sandbox', () => {
    it('en sandbox devuelve el init point de prueba y lo avisa', async () => {
      const link = await service.createCheckout('jwt', PATIENT, APPOINTMENT);

      expect(link.checkoutUrl).toBe('https://mp/checkout/sandbox');
      expect(link.sandbox).toBe(true);
    });

    it('en producción devuelve el init point real', async () => {
      mercadopago.isSandbox.mockReturnValue(false);

      const link = await service.createCheckout('jwt', PATIENT, APPOINTMENT);

      expect(link.checkoutUrl).toBe('https://mp/checkout/prod');
      expect(link.sandbox).toBe(false);
    });
  });

  describe('back urls', () => {
    it('las tres vuelven a la pantalla de pago del turno', async () => {
      await service.createCheckout('jwt', PATIENT, APPOINTMENT);

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
});
