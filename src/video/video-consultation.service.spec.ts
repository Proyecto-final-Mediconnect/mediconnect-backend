import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { DailyService } from './daily.service';
import { VideoConsultationService } from './video-consultation.service';

/**
 * Reglas de ingreso a la videoconsulta (ENG-56).
 *
 * Daily, Supabase y Prisma van mockeados: lo que se verifica acá son las cuatro
 * decisiones del service (quién entra, con qué estado, en qué ventana, y que la
 * sala se cree una sola vez). El borde HTTP lo cubre `test/video-consultation.e2e-spec.ts`.
 */

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PROFESSIONAL = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const APPOINTMENT = '44444444-4444-4444-8444-444444444444';
const SCHEDULED_AT = '2026-08-27T15:00:00.000Z';

/** 15:00 - 10 min = la sala abre 14:50. */
const DENTRO_DE_LA_VENTANA = new Date('2026-08-27T14:55:00.000Z');

type AppointmentRow = {
  id: string;
  patient_id: string;
  professional_id: string;
  scheduled_at: string;
  duration_minutes: number;
  status: string;
};

function appointmentRow(overrides: Partial<AppointmentRow> = {}) {
  return {
    id: APPOINTMENT,
    patient_id: PATIENT,
    professional_id: PROFESSIONAL,
    scheduled_at: SCHEDULED_AT,
    duration_minutes: 30,
    status: 'RESERVADO_SIN_PAGAR',
    ...overrides,
  };
}

describe('VideoConsultationService', () => {
  let service: VideoConsultationService;
  let daily: {
    createConsultationRoom: jest.Mock;
    createConsultationToken: jest.Mock;
    deleteRoom: jest.Mock;
  };
  let prisma: {
    consultation: { upsert: jest.Mock };
    videoSession: {
      upsert: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    professional: { findUnique: jest.Mock };
    patient: { findUnique: jest.Mock };
  };
  let maybeSingle: jest.Mock;
  let recordingMode: string | undefined;

  function build(row: AppointmentRow | null, error: unknown = null) {
    maybeSingle = jest.fn().mockResolvedValue({ data: row, error });

    const supabase = {
      getClientForToken: () => ({
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle }) }),
        }),
      }),
    } as unknown as SupabaseService;

    daily = {
      createConsultationRoom: jest.fn().mockResolvedValue({
        name: 'consulta-abc123',
        url: 'https://mediconnect.daily.co/consulta-abc123',
      }),
      createConsultationToken: jest.fn().mockResolvedValue('tok'),
      deleteRoom: jest.fn().mockResolvedValue(undefined),
    };

    prisma = {
      consultation: { upsert: jest.fn().mockResolvedValue({ id: 'cons-1' }) },
      videoSession: {
        upsert: jest.fn().mockResolvedValue({
          id: 'vs-1',
          daily_room_name: null,
          daily_room_url: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      professional: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ first_name: 'Ana', last_name: 'Gómez' }),
      },
      patient: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ first_name: 'Luis', last_name: 'Pérez' }),
      },
    };

    const config = {
      get: jest.fn(() => recordingMode),
    } as unknown as ConfigService;

    service = new VideoConsultationService(
      prisma as unknown as PrismaService,
      supabase,
      daily as unknown as DailyService,
      config,
    );
  }

  beforeEach(() => {
    recordingMode = undefined;
    build(appointmentRow());
  });

  describe('quién puede entrar', () => {
    it('deja entrar al paciente del turno', async () => {
      const access = await service.join(
        'jwt',
        PATIENT,
        APPOINTMENT,
        DENTRO_DE_LA_VENTANA,
      );

      expect(access.role).toBe('PACIENTE');
      expect(access.roomUrl).toBe(
        'https://mediconnect.daily.co/consulta-abc123?t=tok',
      );
    });

    it('deja entrar al profesional del turno, como owner de la sala', async () => {
      const access = await service.join(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        DENTRO_DE_LA_VENTANA,
      );

      expect(access.role).toBe('PROFESIONAL');
      expect(daily.createConsultationToken).toHaveBeenCalledWith(
        expect.objectContaining({ isOwner: true }),
      );
    });

    it('el paciente NO entra como owner: no puede expulsar al profesional', async () => {
      await service.join('jwt', PATIENT, APPOINTMENT, DENTRO_DE_LA_VENTANA);

      expect(daily.createConsultationToken).toHaveBeenCalledWith(
        expect.objectContaining({ isOwner: false }),
      );
    });

    it('devuelve 404 cuando RLS no muestra el turno', async () => {
      // Un turno de otras dos personas no vuelve en el select: para este usuario
      // no existe. Un 403 confirmaría que el id es real.
      build(null);

      await expect(
        service.join('jwt', OTHER, APPOINTMENT, DENTRO_DE_LA_VENTANA),
      ).rejects.toThrow(NotFoundException);
    });

    it('rechaza a un tercero aunque la fila llegue igual', async () => {
      // Defensa en profundidad: hoy RLS no deja llegar acá, pero si la policy se
      // ampliara, el resultado tiene que ser 403 y no un ingreso silencioso.
      await expect(
        service.join('jwt', OTHER, APPOINTMENT, DENTRO_DE_LA_VENTANA),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('ventana horaria', () => {
    it('no deja entrar 11 minutos antes', async () => {
      await expect(
        service.join(
          'jwt',
          PATIENT,
          APPOINTMENT,
          new Date('2026-08-27T14:49:00.000Z'),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('deja entrar justo a los 10 minutos antes', async () => {
      await expect(
        service.join(
          'jwt',
          PATIENT,
          APPOINTMENT,
          new Date('2026-08-27T14:50:00.000Z'),
        ),
      ).resolves.toMatchObject({ role: 'PACIENTE' });
    });

    it('deja entrar dentro de la tolerancia posterior', async () => {
      // 15:00 + 30 de turno + 15 de tolerancia = 15:45.
      await expect(
        service.join(
          'jwt',
          PATIENT,
          APPOINTMENT,
          new Date('2026-08-27T15:44:00.000Z'),
        ),
      ).resolves.toMatchObject({ role: 'PACIENTE' });
    });

    it('no deja entrar pasada la tolerancia', async () => {
      await expect(
        service.join(
          'jwt',
          PATIENT,
          APPOINTMENT,
          new Date('2026-08-27T15:46:00.000Z'),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('no crea ninguna sala cuando rechaza por horario', async () => {
      // Importa: crear salas cuesta plata. Un rechazo no puede haber gastado.
      await expect(
        service.join(
          'jwt',
          PATIENT,
          APPOINTMENT,
          new Date('2026-08-27T10:00:00.000Z'),
        ),
      ).rejects.toThrow(ConflictException);

      expect(daily.createConsultationRoom).not.toHaveBeenCalled();
    });
  });

  describe('estado del turno', () => {
    it.each(['CANCELADO', 'LIBERADO', 'COMPLETADO', 'NO_ASISTIO'])(
      'rechaza un turno en %s',
      async (status) => {
        build(appointmentRow({ status }));

        await expect(
          service.join('jwt', PATIENT, APPOINTMENT, DENTRO_DE_LA_VENTANA),
        ).rejects.toThrow(ConflictException);
      },
    );

    it('acepta CONFIRMADO', async () => {
      build(appointmentRow({ status: 'CONFIRMADO' }));

      await expect(
        service.join('jwt', PATIENT, APPOINTMENT, DENTRO_DE_LA_VENTANA),
      ).resolves.toMatchObject({ role: 'PACIENTE' });
    });
  });

  describe('la sala se crea una sola vez', () => {
    it('crea la sala cuando entra el primero', async () => {
      await service.join('jwt', PATIENT, APPOINTMENT, DENTRO_DE_LA_VENTANA);

      expect(daily.createConsultationRoom).toHaveBeenCalledTimes(1);
      expect(prisma.videoSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'vs-1', daily_room_name: null },
        }),
      );
    });

    it('reusa la sala guardada cuando entra el segundo', async () => {
      prisma.videoSession.upsert.mockResolvedValue({
        id: 'vs-1',
        daily_room_name: 'consulta-yaexiste',
        daily_room_url: 'https://mediconnect.daily.co/consulta-yaexiste',
      });

      const access = await service.join(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        DENTRO_DE_LA_VENTANA,
      );

      expect(daily.createConsultationRoom).not.toHaveBeenCalled();
      expect(access.roomUrl).toBe(
        'https://mediconnect.daily.co/consulta-yaexiste?t=tok',
      );
    });

    it('si pierde la carrera usa la sala del otro y borra la suya', async () => {
      // Los dos entraron a la vez: el `updateMany` condicional no afecta filas
      // porque el otro ya guardó la suya. Quedarse con la propia dejaría a cada
      // uno en una sala distinta, que es el peor resultado posible.
      prisma.videoSession.updateMany.mockResolvedValue({ count: 0 });
      prisma.videoSession.findUniqueOrThrow.mockResolvedValue({
        daily_room_name: 'consulta-delotro',
        daily_room_url: 'https://mediconnect.daily.co/consulta-delotro',
      });

      const access = await service.join(
        'jwt',
        PATIENT,
        APPOINTMENT,
        DENTRO_DE_LA_VENTANA,
      );

      expect(access.roomUrl).toBe(
        'https://mediconnect.daily.co/consulta-delotro?t=tok',
      );
      expect(daily.deleteRoom).toHaveBeenCalledWith('consulta-abc123');
    });

    it('la sala expira al cerrarse la ventana del turno', async () => {
      const access = await service.join(
        'jwt',
        PATIENT,
        APPOINTMENT,
        DENTRO_DE_LA_VENTANA,
      );

      // 15:45 UTC en segundos.
      const esperado = Math.floor(
        new Date('2026-08-27T15:45:00.000Z').getTime() / 1000,
      );
      expect(daily.createConsultationRoom).toHaveBeenCalledWith(
        esperado,
        'off',
      );
      expect(access.expiresAt).toBe('2026-08-27T15:45:00.000Z');
    });
  });

  describe('grabación de audio', () => {
    it('viene apagada si el entorno no la configura', async () => {
      const access = await service.join(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        DENTRO_DE_LA_VENTANA,
      );

      expect(access.recording).toEqual({ enabled: false, mode: 'off' });
      expect(daily.createConsultationToken).toHaveBeenCalledWith(
        expect.objectContaining({ startRecording: false }),
      );
    });

    it('un valor desconocido cae en apagado', async () => {
      // Ante una variable mal escrita, la opción segura es no grabar.
      recordingMode = 'cloud';
      build(appointmentRow());

      const access = await service.join(
        'jwt',
        PATIENT,
        APPOINTMENT,
        DENTRO_DE_LA_VENTANA,
      );

      expect(access.recording.enabled).toBe(false);
    });

    it('arranca sola con el profesional cuando está habilitada', async () => {
      recordingMode = 'cloud-audio-only';
      build(appointmentRow());

      const access = await service.join(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        DENTRO_DE_LA_VENTANA,
      );

      expect(access.recording).toEqual({
        enabled: true,
        mode: 'cloud-audio-only',
      });
      expect(daily.createConsultationToken).toHaveBeenCalledWith(
        expect.objectContaining({ startRecording: true }),
      );
    });

    it('el paciente nunca dispara la grabación', async () => {
      // Quien responde por el tratamiento de los datos clínicos es el
      // profesional; el paciente no puede iniciar una grabación por su cuenta.
      recordingMode = 'cloud-audio-only';
      build(appointmentRow());

      await service.join('jwt', PATIENT, APPOINTMENT, DENTRO_DE_LA_VENTANA);

      expect(daily.createConsultationToken).toHaveBeenCalledWith(
        expect.objectContaining({ startRecording: false }),
      );
    });
  });

  describe('contraparte', () => {
    it('al paciente le muestra el profesional', async () => {
      const access = await service.join(
        'jwt',
        PATIENT,
        APPOINTMENT,
        DENTRO_DE_LA_VENTANA,
      );

      expect(access.counterpart).toEqual({
        firstName: 'Ana',
        lastName: 'Gómez',
      });
    });

    it('al profesional le muestra el paciente', async () => {
      const access = await service.join(
        'jwt',
        PROFESSIONAL,
        APPOINTMENT,
        DENTRO_DE_LA_VENTANA,
      );

      expect(access.counterpart).toEqual({
        firstName: 'Luis',
        lastName: 'Pérez',
      });
    });

    it('sigue funcionando si la contraparte no tiene perfil cargado', async () => {
      prisma.professional.findUnique.mockResolvedValue(null);

      const access = await service.join(
        'jwt',
        PATIENT,
        APPOINTMENT,
        DENTRO_DE_LA_VENTANA,
      );

      expect(access.counterpart).toBeNull();
      expect(access.roomUrl).toContain('?t=tok');
    });
  });
});
