import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { OpenEmergencySessionDto } from './dto/open-emergency-session.dto';
import { CARD_TOKEN_LENGTH, CODIGO_INVALIDO } from './medipass.config';
import { hashCardToken, MediPassService } from './medipass.service';

/**
 * Tarjeta de emergencia del MediPass (ENG-176): el QR fijo para que atiendan a
 * un paciente inconsciente o sin el celular.
 */
const PATIENT = '11111111-1111-4111-8111-111111111111';
const CARD_ID = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'a'.repeat(CARD_TOKEN_LENGTH);

const PATIENT_ROW = {
  first_name: 'Marina',
  last_name: 'Ocampo',
  birth_date: new Date('1991-03-02T00:00:00.000Z'),
  medipass_scope: null,
};

describe('Tarjeta de emergencia del MediPass (ENG-176)', () => {
  let prisma: {
    patient: { findUnique: jest.Mock };
    mediPassCode: { findFirst: jest.Mock; update: jest.Mock };
    mediPassEmergencyCard: {
      findFirst: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
    };
    mediPassSession: { create: jest.Mock; updateMany: jest.Mock };
    mediPassAccessLog: { create: jest.Mock };
    auditLog: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let inApp: { notifyMediPassAccess: jest.Mock };
  let service: MediPassService;

  beforeEach(() => {
    prisma = {
      patient: { findUnique: jest.fn().mockResolvedValue(PATIENT_ROW) },
      mediPassCode: { findFirst: jest.fn(), update: jest.fn() },
      mediPassEmergencyCard: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: { created_at: Date } }) =>
            Promise.resolve({ id: CARD_ID, created_at: data.created_at }),
          ),
      },
      mediPassSession: {
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      mediPassAccessLog: { create: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    inApp = { notifyMediPassAccess: jest.fn().mockResolvedValue(undefined) };
    service = new MediPassService(
      prisma as unknown as PrismaService,
      inApp as unknown as InAppNotificationsService,
    );
  });

  describe('createMyEmergencyCard', () => {
    it('test_should_store_emergency_token_hashed', async () => {
      const res = await service.createMyEmergencyCard(PATIENT);

      expect(res.tarjeta).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(res.tarjeta).toHaveLength(CARD_TOKEN_LENGTH);
      const { data } = prisma.mediPassEmergencyCard.create.mock.calls[0][0];
      // Se guarda el hash y nunca el token.
      expect(data.token_hash).toBe(hashCardToken(res.tarjeta));
      expect(data.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(data)).not.toContain(res.tarjeta);
    });

    it('dos tarjetas seguidas tienen tokens distintos', async () => {
      const a = await service.createMyEmergencyCard(PATIENT);
      const b = await service.createMyEmergencyCard(PATIENT);
      expect(a.tarjeta).not.toBe(b.tarjeta);
    });

    it('regenerar revoca la anterior y corta solo los accesos abiertos con ella', async () => {
      prisma.mediPassEmergencyCard.findFirst.mockResolvedValue({ id: 'vieja' });

      await service.createMyEmergencyCard(PATIENT);

      expect(prisma.mediPassEmergencyCard.updateMany).toHaveBeenCalledWith({
        where: { id: 'vieja', revoked_at: null },
        data: { revoked_at: expect.any(Date) },
      });
      expect(prisma.mediPassSession.updateMany).toHaveBeenCalledWith({
        where: {
          emergency_card_id: 'vieja',
          revoked_at: null,
          expires_at: { gt: expect.any(Date) },
        },
        data: { revoked_at: expect.any(Date), revoked_by: PATIENT },
      });
      // La revocación va antes que la nueva tarjeta, en la misma transacción.
      expect(
        prisma.mediPassEmergencyCard.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(
        prisma.mediPassEmergencyCard.create.mock.invocationCallOrder[0],
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('deja constancia en audit_logs', async () => {
      await service.createMyEmergencyCard(PATIENT);
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: PATIENT,
          action: 'MEDIPASS_CARD_CREATED',
          resource_id: CARD_ID,
        }),
      });
    });

    it('si falla el log, la tarjeta igual se entrega', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('caído'));
      await expect(service.createMyEmergencyCard(PATIENT)).resolves.toEqual(
        expect.objectContaining({ tarjeta: expect.any(String) }),
      );
    });

    it('dos generaciones simultáneas: la que pierde recibe 409', async () => {
      prisma.mediPassEmergencyCard.create.mockRejectedValue({ code: 'P2002' });
      await expect(service.createMyEmergencyCard(PATIENT)).rejects.toThrow(
        ConflictException,
      );
    });

    it('un usuario sin fila de paciente recibe 409 y no genera nada', async () => {
      prisma.patient.findUnique.mockResolvedValue(null);
      await expect(service.createMyEmergencyCard(PATIENT)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.mediPassEmergencyCard.create).not.toHaveBeenCalled();
    });
  });

  describe('getMyEmergencyCard', () => {
    it('sin tarjeta: inactiva', async () => {
      await expect(service.getMyEmergencyCard(PATIENT)).resolves.toEqual({
        activa: false,
        creadaEl: null,
      });
    });

    it('con tarjeta: activa y desde cuándo, nunca el token', async () => {
      prisma.mediPassEmergencyCard.findFirst.mockResolvedValue({
        created_at: new Date('2026-11-04T12:00:00.000Z'),
      });
      const res = await service.getMyEmergencyCard(PATIENT);
      expect(res).toEqual({
        activa: true,
        creadaEl: '2026-11-04T12:00:00.000Z',
      });
      expect(prisma.mediPassEmergencyCard.findFirst).toHaveBeenCalledWith({
        where: { patient_id: PATIENT, revoked_at: null },
        select: { created_at: true },
      });
    });
  });

  describe('disableMyEmergencyCard', () => {
    it('test_should_reject_token_given_card_disabled: la revoca y corta sus accesos', async () => {
      prisma.mediPassEmergencyCard.findFirst.mockResolvedValue({ id: CARD_ID });

      await service.disableMyEmergencyCard(PATIENT);

      expect(prisma.mediPassEmergencyCard.updateMany).toHaveBeenCalled();
      expect(prisma.mediPassSession.updateMany).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'MEDIPASS_CARD_DISABLED' }),
      });
    });

    it('sin tarjeta activa es idempotente: no toca ni audita nada', async () => {
      await expect(
        service.disableMyEmergencyCard(PATIENT),
      ).resolves.toBeUndefined();
      expect(prisma.mediPassEmergencyCard.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('si otro pedido la revocó primero, no se audita una revocación ajena', async () => {
      prisma.mediPassEmergencyCard.findFirst.mockResolvedValue({ id: CARD_ID });
      prisma.mediPassEmergencyCard.updateMany.mockResolvedValue({ count: 0 });

      await service.disableMyEmergencyCard(PATIENT);

      expect(prisma.mediPassSession.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('openSession con la tarjeta', () => {
    const dto: OpenEmergencySessionDto = {
      tarjeta: TOKEN,
      nombre: 'Dr. Pablo Rivas',
      matricula: 'MP 12345',
    };

    it('test_should_open_session_given_valid_emergency_card_token', async () => {
      prisma.mediPassEmergencyCard.findFirst.mockResolvedValue({
        id: CARD_ID,
        patient_id: PATIENT,
        patient: PATIENT_ROW,
      });

      const res = await service.openSession(dto);

      expect(prisma.mediPassEmergencyCard.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { token_hash: hashCardToken(TOKEN), revoked_at: null },
        }),
      );
      const { data } = prisma.mediPassSession.create.mock.calls[0][0];
      expect(data).toEqual(
        expect.objectContaining({
          patient_id: PATIENT,
          emergency_card_id: CARD_ID,
          medipass_code_id: null,
        }),
      );
      // 30 minutos, como el código.
      const minutos = (new Date(res.expiraEl).getTime() - Date.now()) / 60_000;
      expect(minutos).toBeGreaterThan(29);
      expect(minutos).toBeLessThanOrEqual(30);
      expect(res.vital.nombre).toBe('Marina Ocampo');
      expect(prisma.mediPassAccessLog.create).toHaveBeenCalled();
      expect(prisma.mediPassCode.findFirst).not.toHaveBeenCalled();
      expect(prisma.mediPassCode.update).not.toHaveBeenCalled();
      expect(inApp.notifyMediPassAccess).toHaveBeenCalledWith(
        PATIENT,
        expect.objectContaining({ origen: 'TARJETA' }),
        expect.any(Date),
      );
    });

    it('test_should_reject_old_token_given_card_regenerated: mismo 404 que un código inválido', async () => {
      await expect(service.openSession(dto)).rejects.toThrow(
        new NotFoundException(CODIGO_INVALIDO),
      );
      expect(prisma.mediPassSession.create).not.toHaveBeenCalled();
    });

    it('código y tarjeta a la vez es un pedido mal armado (400)', async () => {
      await expect(
        service.openSession({ ...dto, codigo: 'BCD23FGH' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('sin código ni tarjeta también es 400', async () => {
      await expect(
        service.openSession({ nombre: 'Dr. Pablo Rivas' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
