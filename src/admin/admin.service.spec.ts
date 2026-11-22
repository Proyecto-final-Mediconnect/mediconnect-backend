import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ProfessionalAccountNoticesService } from '../notifications/professional-account-notices.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProfessionalStatsService } from '../professionals/professional-stats.service';
import { AdminService } from './admin.service';

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-11-22T12:00:00.000Z');

/** ENG-192 — validar o rechazar la matrícula. */
describe('AdminService · matrículas', () => {
  let prisma: {
    professional: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    auditLog: { create: jest.Mock; findMany: jest.Mock };
    appointment: { groupBy: jest.Mock };
    review: { groupBy: jest.Mock };
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let stats: { get: jest.Mock };
  let notices: { licenseDecided: jest.Mock };
  let service: AdminService;

  const row = (
    id: string,
    created: string,
    status = 'PENDIENTE_VALIDACION_MATRICULA',
  ) => ({
    profile_id: id,
    first_name: 'Ana',
    last_name: 'Pérez',
    license_number: 'MP-123',
    created_at: new Date(created),
    status,
    profile: { email: `${id.slice(0, 4)}@test.com` },
    specialties: [
      { specialty: { name: 'Pediatría' } },
      { specialty: { name: 'Clínica médica' } },
    ],
  });

  beforeEach(() => {
    prisma = {
      professional: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      appointment: { groupBy: jest.fn().mockResolvedValue([]) },
      review: { groupBy: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(prisma),
    );
    notices = { licenseDecided: jest.fn().mockResolvedValue(undefined) };
    stats = {
      get: jest.fn().mockResolvedValue({ turnos: { completados: 3 } }),
    };
    service = new AdminService(
      prisma as unknown as PrismaService,
      notices as unknown as ProfessionalAccountNoticesService,
      stats as unknown as ProfessionalStatsService,
    );
  });

  describe('licenseQueue', () => {
    it('los pendientes, del más viejo al más nuevo, sin datos de la decisión', async () => {
      prisma.professional.findMany.mockResolvedValue([
        row(PRO, '2026-11-01T10:00:00Z'),
      ]);

      const cola = await service.licenseQueue('PENDIENTE_VALIDACION_MATRICULA');

      expect(prisma.professional.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'PENDIENTE_VALIDACION_MATRICULA',
            profile: { deleted_at: null },
          },
          orderBy: [{ created_at: 'asc' }, { profile_id: 'asc' }],
        }),
      );
      expect(cola).toEqual([
        {
          id: PRO,
          firstName: 'Ana',
          lastName: 'Pérez',
          email: 'bbbb@test.com',
          licenseNumber: 'MP-123',
          specialties: ['Clínica médica', 'Pediatría'],
          registeredAt: '2026-11-01T10:00:00.000Z',
          status: 'PENDIENTE_VALIDACION_MATRICULA',
          decision: null,
        },
      ]);
      // Un pendiente no tiene decisión: no se consulta la auditoría.
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it('los rechazados traen el motivo de la auditoría, la decisión más nueva primero', async () => {
      const OTRO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const SIN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      prisma.professional.findMany.mockResolvedValue([
        row(PRO, '2026-11-01T10:00:00Z', 'RECHAZADO'),
        row(OTRO, '2026-11-02T10:00:00Z', 'RECHAZADO'),
        row(SIN, '2026-11-03T10:00:00Z', 'RECHAZADO'),
      ]);
      prisma.auditLog.findMany.mockResolvedValue([
        {
          resource_id: PRO,
          created_at: new Date('2026-11-20T10:00:00Z'),
          metadata: { reason: 'No figura en REFEPS.' },
        },
        {
          resource_id: OTRO,
          created_at: new Date('2026-11-10T10:00:00Z'),
          metadata: {},
        },
        // Una decisión más vieja del mismo profesional no pisa la última.
        {
          resource_id: PRO,
          created_at: new Date('2026-11-05T10:00:00Z'),
          metadata: { reason: 'Vieja' },
        },
      ]);

      const cola = await service.licenseQueue('RECHAZADO');

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            resource_type: 'professionals',
            resource_id: { in: [PRO, OTRO, SIN] },
            action: 'PROFESSIONAL_LICENSE_REJECTED',
          },
        }),
      );
      expect(cola.map((p) => [p.id, p.decision])).toEqual([
        [
          PRO,
          { at: '2026-11-20T10:00:00.000Z', reason: 'No figura en REFEPS.' },
        ],
        [OTRO, { at: '2026-11-10T10:00:00.000Z', reason: null }],
        // Sin decisión auditada (validado por SQL o por el seed): al final.
        [SIN, null],
      ]);
    });
  });

  describe('decideLicense', () => {
    it('valida: solo desde pendiente, auditado con el origen, y avisa al profesional', async () => {
      const res = await service.decideLicense(
        ADMIN,
        PRO,
        { decision: 'VALIDADO' },
        NOW,
      );

      expect(res).toEqual({ id: PRO, status: 'VALIDADO' });
      expect(prisma.professional.updateMany).toHaveBeenCalledWith({
        where: {
          profile_id: PRO,
          status: 'PENDIENTE_VALIDACION_MATRICULA',
          profile: { deleted_at: null },
        },
        data: { status: 'VALIDADO', updated_at: NOW },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          actor_id: ADMIN,
          action: 'PROFESSIONAL_LICENSE_VALIDATED',
          resource_type: 'professionals',
          resource_id: PRO,
          metadata: {
            origin: 'ADMINISTRADOR',
            previousStatus: 'PENDIENTE_VALIDACION_MATRICULA',
          },
        },
      });
      expect(notices.licenseDecided).toHaveBeenCalledWith(
        PRO,
        'VALIDADO',
        null,
      );
    });

    it('rechaza con el motivo recortado, en la auditoría y en el aviso', async () => {
      await service.decideLicense(
        ADMIN,
        PRO,
        { decision: 'RECHAZADO', reason: '  No figura en REFEPS.  ' },
        NOW,
      );

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'PROFESSIONAL_LICENSE_REJECTED',
            metadata: expect.objectContaining({
              reason: 'No figura en REFEPS.',
            }),
          }),
        }),
      );
      expect(notices.licenseDecided).toHaveBeenCalledWith(
        PRO,
        'RECHAZADO',
        'No figura en REFEPS.',
      );
    });

    it('si ya tiene una decisión da 409, sin auditar ni avisar', async () => {
      prisma.professional.updateMany.mockResolvedValue({ count: 0 });
      prisma.professional.findUnique.mockResolvedValue({ status: 'VALIDADO' });

      await expect(
        service.decideLicense(ADMIN, PRO, {
          decision: 'RECHAZADO',
          reason: 'Motivo largo de prueba',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(notices.licenseDecided).not.toHaveBeenCalled();
    });

    it('un profesional que no existe da 404', async () => {
      prisma.professional.updateMany.mockResolvedValue({ count: 0 });
      prisma.professional.findUnique.mockResolvedValue(null);

      await expect(
        service.decideLicense(ADMIN, PRO, { decision: 'VALIDADO' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listProfessionals (ENG-241)', () => {
    const NOW2 = new Date('2026-11-22T12:00:00.000Z');

    it('filtra por estado y busca por nombre o matrícula, de a 20, por apellido', async () => {
      await service.listProfessionals(
        { status: 'VALIDADO', q: '  pérez ', page: 2 },
        NOW2,
      );

      const where = {
        profile: { deleted_at: null },
        status: 'VALIDADO',
        OR: [
          { first_name: { contains: 'pérez', mode: 'insensitive' } },
          { last_name: { contains: 'pérez', mode: 'insensitive' } },
          { license_number: { contains: 'pérez', mode: 'insensitive' } },
        ],
      };
      expect(prisma.professional.count).toHaveBeenCalledWith({ where });
      expect(prisma.professional.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where,
          orderBy: [
            { last_name: 'asc' },
            { first_name: 'asc' },
            { profile_id: 'asc' },
          ],
          skip: 20,
          take: 20,
        }),
      );
    });

    it('suma la actividad de la página entera de una vez', async () => {
      const OTRO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      prisma.professional.count.mockResolvedValue(2);
      prisma.professional.findMany.mockResolvedValue([
        row(PRO, '2026-08-01T10:00:00Z', 'VALIDADO'),
        row(OTRO, '2026-09-01T10:00:00Z', 'SUSPENDIDO'),
      ]);
      prisma.appointment.groupBy.mockResolvedValue([
        { professional_id: PRO, _count: { _all: 7 } },
      ]);
      prisma.$queryRaw.mockResolvedValue([{ professional_id: PRO, n: 2 }]);
      prisma.review.groupBy.mockResolvedValue([
        { professional_id: PRO, _avg: { rating: 4.666 }, _count: { _all: 3 } },
      ]);

      const page = await service.listProfessionals({}, NOW2);

      expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20 });
      expect(page.items.map((i) => [i.id, i.status, i.activity])).toEqual([
        [
          PRO,
          'VALIDADO',
          { completed: 7, incidents: 2, rating: 4.7, reviews: 3 },
        ],
        [
          OTRO,
          'SUSPENDIDO',
          { completed: 0, incidents: 0, rating: null, reviews: 0 },
        ],
      ]);
      // Tres consultas para toda la página, no tres por profesional.
      expect(prisma.appointment.groupBy).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.review.groupBy).toHaveBeenCalledTimes(1);
      // Los completados son de los últimos 3 meses.
      expect(prisma.appointment.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'COMPLETADO',
            scheduled_at: {
              gte: new Date('2026-08-22T12:00:00.000Z'),
              lte: NOW2,
            },
          }),
        }),
      );
    });

    it('sin resultados no consulta la actividad', async () => {
      const page = await service.listProfessionals({ q: 'nadie' }, NOW2);

      expect(page.items).toEqual([]);
      expect(prisma.appointment.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('professionalDetail (ENG-241)', () => {
    it('devuelve los datos y la misma actividad que "Mi actividad"', async () => {
      prisma.professional.findUnique.mockResolvedValue({
        ...row(PRO, '2026-08-01T10:00:00Z', 'VALIDADO'),
        consultation_price: {
          toString: () => '15000.00',
          valueOf: () => 15000,
        },
        currency: 'ARS',
        profile: { email: 'ana@test.com', deleted_at: null },
      });

      const detail = await service.professionalDetail(PRO, NOW);

      expect(detail).toMatchObject({
        id: PRO,
        email: 'ana@test.com',
        status: 'VALIDADO',
        consultationPrice: 15000,
        stats: { turnos: { completados: 3 } },
      });
      expect(stats.get).toHaveBeenCalledWith(PRO, {}, NOW);
    });

    it('uno que no existe o se dio de baja da 404', async () => {
      prisma.professional.findUnique.mockResolvedValue(null);
      await expect(service.professionalDetail(PRO)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
