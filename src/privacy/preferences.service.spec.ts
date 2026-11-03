import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PreferencesService } from './preferences.service';

const USER = '11111111-1111-4111-8111-111111111111';

/** Derecho de oposición (ENG-86): apagar los recordatorios por email. */
describe('PreferencesService', () => {
  let prisma: { profile: { findUnique: jest.Mock; updateMany: jest.Mock } };
  let service: PreferencesService;

  beforeEach(() => {
    prisma = {
      profile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ email_reminders: true, deleted_at: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new PreferencesService(prisma as unknown as PrismaService);
  });

  it('por defecto los recordatorios están prendidos', async () => {
    await expect(service.get(USER)).resolves.toEqual({
      recordatoriosPorEmail: true,
    });
  });

  it('los apaga solo para la cuenta del token', async () => {
    await expect(service.update(USER, false)).resolves.toEqual({
      recordatoriosPorEmail: false,
    });
    expect(prisma.profile.updateMany).toHaveBeenCalledWith({
      where: { id: USER, deleted_at: null },
      data: { email_reminders: false },
    });
  });

  it('una cuenta dada de baja no tiene preferencias', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      email_reminders: false,
      deleted_at: new Date(),
    });
    prisma.profile.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.get(USER)).rejects.toThrow(NotFoundException);
    await expect(service.update(USER, true)).rejects.toThrow(NotFoundException);
  });
});
