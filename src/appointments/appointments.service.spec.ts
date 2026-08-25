import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { toInstant } from '../common/time/argentina-time';
import {
  AppointmentsService,
  BOOKING_HORIZON_DAYS,
} from './appointments.service';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const PRO_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'access-token';

/** Lunes 17/08/2026. Todos los casos se paran en las 08:00 de ese día. */
const MONDAY = '2026-08-17';
const NOW = new Date('2026-08-17T11:00:00Z'); // 08:00 en Argentina

/** Franja de lunes 09:00-11:00 con turnos de 30, tal como la guarda ENG-53. */
const RULE_ROW = {
  weekday: 1,
  start_time: new Date('1970-01-01T09:00:00Z'),
  end_time: new Date('1970-01-01T11:00:00Z'),
  slot_duration_minutes: 30,
};

const PRO_ROW = {
  profile_id: PRO_ID,
  first_name: 'Ana',
  last_name: 'Médica',
  consultation_price: 15000,
  currency: 'ARS',
};

const INSERTED_ROW = {
  id: '33333333-3333-4333-8333-333333333333',
  patient_id: PATIENT_ID,
  professional_id: PRO_ID,
  scheduled_at: '2026-08-17T13:00:00.000Z', // 10:00 local
  duration_minutes: 30,
  price: '15000.00',
  status: 'RESERVADO_SIN_PAGAR',
};

/**
 * Lo que devuelve `prisma.appointment.update` al cancelar. Ojo con las formas:
 * Prisma entrega `scheduled_at` como `Date` y `price` como `Decimal`, no como los
 * strings que manda PostgREST. `cancel` tiene que convertirlos, y este mock es lo
 * que verifica que lo haga.
 */
const CANCELLED_PRISMA_ROW = {
  ...INSERTED_ROW,
  scheduled_at: new Date(INSERTED_ROW.scheduled_at),
  price: { toString: () => '15000.00' },
  status: 'CANCELADO',
};

describe('AppointmentsService', () => {
  let service: AppointmentsService;
  let prisma: {
    professional: { findFirst: jest.Mock; findMany: jest.Mock };
    patient: { findMany: jest.Mock };
    scheduleRule: { findMany: jest.Mock };
    scheduleBlock: { findMany: jest.Mock };
    appointment: { findMany: jest.Mock; update: jest.Mock };
  };
  /** Cola de respuestas del cliente PostgREST mockeado, en orden de consumo. */
  let results: { data: unknown; error: unknown }[];
  /** Payloads pasados a `.insert(...)`, para afirmar qué se escribe. */
  let inserts: Record<string, unknown>[];

  /** Cliente Supabase encadenable: cada método devuelve el mismo builder y el
   *  `await` consume la próxima respuesta de la cola. */
  function makeSupabaseMock() {
    const builder: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (value: unknown) => void) =>
              resolve(results.shift() ?? { data: null, error: null });
          }
          return (...args: unknown[]) => {
            if (prop === 'insert') {
              inserts.push(args[0] as Record<string, unknown>);
            }
            return builder;
          };
        },
      },
    );
    return {
      getClient: () => ({ from: () => builder }),
      getClientForToken: () => ({ from: () => builder }),
    } as unknown as SupabaseService;
  }

  beforeEach(() => {
    results = [];
    inserts = [];
    prisma = {
      professional: {
        findFirst: jest.fn().mockResolvedValue(PRO_ROW),
        findMany: jest.fn().mockResolvedValue([PRO_ROW]),
      },
      patient: {
        findMany: jest.fn().mockResolvedValue([
          {
            profile_id: PATIENT_ID,
            first_name: 'Juan',
            last_name: 'Paciente',
          },
        ]),
      },
      scheduleRule: { findMany: jest.fn().mockResolvedValue([RULE_ROW]) },
      scheduleBlock: { findMany: jest.fn().mockResolvedValue([]) },
      appointment: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(CANCELLED_PRISMA_ROW),
      },
    };

    service = new AppointmentsService(
      prisma as unknown as PrismaService,
      makeSupabaseMock(),
    );
  });

  /** Respuestas de un `book` que llega hasta el insert sin tropezar. */
  const PATIENT_EXISTS = { data: { profile_id: PATIENT_ID }, error: null };
  const NO_COLLISION = { data: [], error: null };
  const INSERT_OK = { data: INSERTED_ROW, error: null };

  describe('getAvailability', () => {
    it('devuelve la grilla del profesional con sus horarios', async () => {
      const view = await service.getAvailability(
        PRO_ID,
        { from: MONDAY, to: MONDAY },
        NOW,
      );

      expect(view.professional).toEqual({
        id: PRO_ID,
        firstName: 'Ana',
        lastName: 'Médica',
        consultationPrice: 15000,
        currency: 'ARS',
      });
      expect(view.days).toHaveLength(1);
      expect(view.days[0].slots.map((s) => s.startTime)).toEqual([
        '09:00',
        '09:30',
        '10:00',
        '10:30',
      ]);
    });

    it('marca ocupados los horarios que ya tienen turno', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        { scheduled_at: toInstant(MONDAY, '09:30'), duration_minutes: 30 },
      ]);

      const view = await service.getAvailability(
        PRO_ID,
        { from: MONDAY, to: MONDAY },
        NOW,
      );

      expect(view.days[0].slots[1]).toMatchObject({
        startTime: '09:30',
        status: 'BOOKED',
      });
    });

    it('solo cuenta como ocupados los turnos en estado activo', async () => {
      // Un turno cancelado no bloquea el horario: se tiene que poder revender.
      await service.getAvailability(PRO_ID, { from: MONDAY, to: MONDAY }, NOW);

      const where = prisma.appointment.findMany.mock.calls[0][0].where as {
        status: { in: string[] };
      };
      expect(where.status.in).toEqual(['RESERVADO_SIN_PAGAR', 'CONFIRMADO']);
    });

    it('un profesional sin validar no existe para el paciente', async () => {
      prisma.professional.findFirst.mockResolvedValue(null);

      await expect(
        service.getAvailability(PRO_ID, { from: MONDAY, to: MONDAY }, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Mismo 404 que "no existe": con mensajes distintos se podría averiguar
      // qué profesionales están pendientes de validación probando UUIDs.
      const where = prisma.professional.findFirst.mock.calls[0][0].where as {
        status: string;
      };
      expect(where.status).toBe('VALIDADO');
    });

    it('rechaza el rango invertido', async () => {
      await expect(
        service.getAvailability(
          PRO_ID,
          { from: '2026-08-20', to: MONDAY },
          NOW,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza un rango más largo que el tope por consulta', async () => {
      await expect(
        service.getAvailability(
          PRO_ID,
          { from: MONDAY, to: '2026-09-30' },
          NOW,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza pedir más allá del horizonte de 4 semanas', async () => {
      // Hoy + 28 días ya está fuera: el horizonte incluye hoy.
      await expect(
        service.getAvailability(
          PRO_ID,
          { from: '2026-09-10', to: '2026-09-14' },
          NOW,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('acepta un "desde" en el pasado y marca esos horarios como pasados', async () => {
      // La pantalla pide semanas completas de lunes a domingo, y la semana en
      // curso empieza antes que hoy.
      const view = await service.getAvailability(
        PRO_ID,
        { from: '2026-08-10', to: MONDAY },
        NOW,
      );

      expect(view.days).toHaveLength(8);
      const pastMonday = view.days[0];
      expect(pastMonday.slots.every((s) => s.status === 'PAST')).toBe(true);
    });
  });

  describe('book', () => {
    const VALID = { professionalId: PRO_ID, date: MONDAY, startTime: '10:00' };

    it('reserva el turno y devuelve la vista con la hora local', async () => {
      results = [PATIENT_EXISTS, NO_COLLISION, INSERT_OK];

      const view = await service.book(TOKEN, PATIENT_ID, VALID, NOW);

      expect(view).toMatchObject({
        id: INSERTED_ROW.id,
        date: MONDAY,
        startTime: '10:00',
        durationMinutes: 30,
        price: 15000,
        currency: 'ARS',
        status: 'RESERVADO_SIN_PAGAR',
      });
      expect(view.professional).toEqual({
        id: PRO_ID,
        firstName: 'Ana',
        lastName: 'Médica',
      });
    });

    it('el servidor decide precio, duración, paciente y estado', async () => {
      results = [PATIENT_EXISTS, NO_COLLISION, INSERT_OK];

      await service.book(TOKEN, PATIENT_ID, VALID, NOW);

      expect(inserts[0]).toEqual({
        patient_id: PATIENT_ID,
        professional_id: PRO_ID,
        // 10:00 en Argentina = 13:00 UTC.
        scheduled_at: '2026-08-17T13:00:00.000Z',
        duration_minutes: 30,
        price: 15000,
      });
      // `status` no se manda: lo pone el DEFAULT de la columna. Si apareciera acá,
      // sería el primer paso hacia aceptarlo del cliente.
      expect(inserts[0]).not.toHaveProperty('status');
    });

    it('rechaza un horario que no está en la agenda', async () => {
      await expect(
        service.book(TOKEN, PATIENT_ID, { ...VALID, startTime: '10:15' }, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(inserts).toHaveLength(0);
    });

    it('rechaza un horario ya pasado', async () => {
      // Son las 08:00 locales; las 09:00 del día anterior ya pasaron.
      await expect(
        service.book(
          TOKEN,
          PATIENT_ID,
          { ...VALID, date: '2026-08-10', startTime: '09:00' },
          NOW,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza un horario más allá del horizonte', async () => {
      await expect(
        service.book(TOKEN, PATIENT_ID, { ...VALID, date: '2026-09-21' }, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza un horario bloqueado por el profesional', async () => {
      prisma.scheduleBlock.findMany.mockResolvedValue([
        {
          block_date: new Date(`${MONDAY}T00:00:00Z`),
          start_time: null,
          end_time: null,
        },
      ]);

      await expect(
        service.book(TOKEN, PATIENT_ID, VALID, NOW),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rechaza un horario que ya tiene turno', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        { scheduled_at: toInstant(MONDAY, '10:00'), duration_minutes: 30 },
      ]);

      await expect(
        service.book(TOKEN, PATIENT_ID, VALID, NOW),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('no deja reservar si el profesional no publicó precio', async () => {
      // `appointments.price` es NOT NULL: el precio se congela en el turno.
      prisma.professional.findFirst.mockResolvedValue({
        ...PRO_ROW,
        consultation_price: null,
      });

      await expect(service.book(TOKEN, PATIENT_ID, VALID, NOW)).rejects.toThrow(
        /precio de consulta/i,
      );
    });

    it('pide completar el perfil de paciente antes de reservar', async () => {
      // La fila de `patients` no existe hasta ENG-47, y patient_id es FK contra
      // ella: sin este chequeo el INSERT fallaría con un 23503 crudo.
      results = [{ data: null, error: null }];

      await expect(service.book(TOKEN, PATIENT_ID, VALID, NOW)).rejects.toThrow(
        /completá tu perfil/i,
      );
      expect(inserts).toHaveLength(0);
    });

    it('no deja reservar dos turnos superpuestos al mismo paciente', async () => {
      results = [
        PATIENT_EXISTS,
        {
          data: [
            {
              scheduled_at: '2026-08-17T13:15:00.000Z', // 10:15 local
              duration_minutes: 30,
            },
          ],
          error: null,
        },
      ];

      await expect(service.book(TOKEN, PATIENT_ID, VALID, NOW)).rejects.toThrow(
        /se superpone/i,
      );
      expect(inserts).toHaveLength(0);
    });

    it('un turno propio contiguo no se considera superpuesto', async () => {
      results = [
        PATIENT_EXISTS,
        {
          data: [
            {
              scheduled_at: '2026-08-17T12:30:00.000Z', // 09:30 local, termina 10:00
              duration_minutes: 30,
            },
          ],
          error: null,
        },
        INSERT_OK,
      ];

      await expect(
        service.book(TOKEN, PATIENT_ID, VALID, NOW),
      ).resolves.toMatchObject({ startTime: '10:00' });
    });

    it('traduce la unique de la base a un 409 entendible', async () => {
      // La carrera real: dos pacientes confirman el mismo horario a la vez y los
      // dos pasan la validación previa. El árbitro es el índice parcial.
      results = [
        PATIENT_EXISTS,
        NO_COLLISION,
        { data: null, error: { code: '23505' } },
      ];

      await expect(service.book(TOKEN, PATIENT_ID, VALID, NOW)).rejects.toThrow(
        /acaba de reservar otra persona/i,
      );
    });

    it('cualquier otro error de la base sale como 500 genérico', async () => {
      results = [
        PATIENT_EXISTS,
        NO_COLLISION,
        { data: null, error: { code: '42501' } },
      ];

      await expect(
        service.book(TOKEN, PATIENT_ID, VALID, NOW),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('el horizonte configurado son 4 semanas', () => {
      expect(BOOKING_HORIZON_DAYS).toBe(28);
    });
  });

  describe('listMine', () => {
    it('devuelve los turnos con los nombres resueltos', async () => {
      results = [{ data: [INSERTED_ROW], error: null }];

      const [view] = await service.listMine(TOKEN, PATIENT_ID);

      expect(view).toMatchObject({
        id: INSERTED_ROW.id,
        date: MONDAY,
        startTime: '10:00',
        price: 15000,
      });
      expect(view.professional?.lastName).toBe('Médica');
      expect(view.patient?.lastName).toBe('Paciente');
    });

    it('sin turnos no consulta nombres', async () => {
      results = [{ data: [], error: null }];

      await expect(service.listMine(TOKEN, PATIENT_ID)).resolves.toEqual([]);
      expect(prisma.professional.findMany).not.toHaveBeenCalled();
    });

    it('un fallo de la base sale como 500', async () => {
      results = [{ data: null, error: { code: '42501' } }];

      await expect(service.listMine(TOKEN, PATIENT_ID)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('cancel', () => {
    const APPOINTMENT_ID = INSERTED_ROW.id;
    /** Lectura previa: el turno existe, es del paciente y todavía no pasó. */
    const READ_OK = { data: INSERTED_ROW, error: null };

    const cancel = (userId = PATIENT_ID) =>
      service.cancel(TOKEN, userId, APPOINTMENT_ID, NOW);

    it('cancela un turno futuro propio', async () => {
      results = [READ_OK];

      const view = await cancel();

      expect(view).toMatchObject({
        id: APPOINTMENT_ID,
        status: 'CANCELADO',
        date: MONDAY,
        startTime: '10:00',
        price: 15000,
      });
    });

    it('revalida las tres condiciones en el where del update', async () => {
      results = [READ_OK];

      await cancel();

      // Sin esto la validación viviría solo en los `if` de arriba y la ventana
      // entre la lectura y la escritura quedaría abierta.
      expect(prisma.appointment.update).toHaveBeenCalledWith({
        where: {
          id: APPOINTMENT_ID,
          patient_id: PATIENT_ID,
          status: { in: ['RESERVADO_SIN_PAGAR', 'CONFIRMADO'] },
          scheduled_at: { gt: NOW },
        },
        data: {
          status: 'CANCELADO',
          cancelled_at: NOW,
          updated_at: NOW,
        },
      });
    });

    it('un turno que RLS no devuelve es un 404, no un 403', async () => {
      results = [{ data: null, error: null }];

      await expect(cancel()).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.appointment.update).not.toHaveBeenCalled();
    });

    it('el profesional ve el turno pero no puede cancelarlo', async () => {
      results = [READ_OK];

      await expect(cancel(PRO_ID)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.appointment.update).not.toHaveBeenCalled();
    });

    it('no se puede cancelar un turno que ya pasó', async () => {
      results = [
        {
          data: { ...INSERTED_ROW, scheduled_at: '2026-08-17T10:00:00.000Z' },
          error: null,
        },
      ];

      await expect(cancel()).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.appointment.update).not.toHaveBeenCalled();
    });

    it('no se puede cancelar dos veces', async () => {
      results = [
        { data: { ...INSERTED_ROW, status: 'CANCELADO' }, error: null },
      ];

      await expect(cancel()).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.appointment.update).not.toHaveBeenCalled();
    });

    it('un turno completado tampoco se cancela', async () => {
      results = [
        { data: { ...INSERTED_ROW, status: 'COMPLETADO' }, error: null },
      ];

      await expect(cancel()).rejects.toBeInstanceOf(ConflictException);
    });

    it('si el estado cambia entre la lectura y el update, sale 409', async () => {
      results = [READ_OK];
      // P2025: el `where` no matcheó. Es la carrera real —doble click, o el job
      // de ENG-101 liberando el turno en el medio.
      prisma.appointment.update.mockRejectedValue({ code: 'P2025' });

      await expect(cancel()).rejects.toBeInstanceOf(ConflictException);
    });

    it('un fallo de la lectura sale como 500', async () => {
      results = [{ data: null, error: { code: '42501' } }];

      await expect(cancel()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('un fallo inesperado del update sale como 500, no como 409', async () => {
      results = [READ_OK];
      prisma.appointment.update.mockRejectedValue(new Error('connection lost'));

      await expect(cancel()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });
});
