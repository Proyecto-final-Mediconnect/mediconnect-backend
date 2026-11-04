import {
  ConflictException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  AccountDeletionService,
  emailDeBaja,
} from './account-deletion.service';

const USER = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'access-token';
const NOW = new Date('2026-11-04T12:00:00.000Z');

/** Derecho de supresión (ENG-86): la baja anonimiza, no borra. */
describe('AccountDeletionService', () => {
  let prisma: Record<string, Record<string, jest.Mock>> & {
    $transaction: jest.Mock;
  };
  let admin: {
    auth: { admin: { updateUserById: jest.Mock; signOut: jest.Mock } };
    storage: { from: jest.Mock };
  };
  let remove: jest.Mock;
  let supabase: { getServiceClient: jest.Mock };
  let service: AccountDeletionService;

  function modelo(...metodos: string[]): Record<string, jest.Mock> {
    return Object.fromEntries(
      metodos.map((m) => [m, jest.fn().mockResolvedValue({ count: 0 })]),
    );
  }

  beforeEach(() => {
    prisma = {
      profile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ role: 'PACIENTE', deleted_at: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      appointment: { count: jest.fn().mockResolvedValue(0) },
      notification: modelo('deleteMany'),
      pushToken: modelo('deleteMany'),
      patient: modelo('updateMany'),
      mediPassCode: modelo('updateMany'),
      mediPassEmergencyCard: modelo('updateMany'),
      mediPassSession: modelo('updateMany'),
      review: modelo('deleteMany'),
      patientDocument: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ storage_path: `${USER}/a.pdf` }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: modelo('updateMany'),
      professional: modelo('updateMany'),
      scheduleRule: modelo('deleteMany'),
      scheduleBlock: modelo('deleteMany'),
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    } as never;
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    remove = jest.fn().mockResolvedValue({ error: null });
    admin = {
      auth: {
        admin: {
          updateUserById: jest.fn().mockResolvedValue({ error: null }),
          signOut: jest.fn().mockResolvedValue({ error: null }),
        },
      },
      storage: { from: jest.fn().mockReturnValue({ remove }) },
    };
    supabase = { getServiceClient: jest.fn().mockReturnValue(admin) };
    service = new AccountDeletionService(
      prisma as unknown as PrismaService,
      supabase as unknown as SupabaseService,
    );
  });

  it('sin la service role no toca nada y contesta 503', async () => {
    supabase.getServiceClient.mockImplementation(() => {
      throw new Error('falta la key');
    });

    await expect(service.deleteMyAccount(USER, TOKEN, NOW)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('con turnos pendientes no da de baja y dice cuántos', async () => {
    prisma.appointment.count.mockResolvedValue(2);

    await expect(service.deleteMyAccount(USER, TOKEN, NOW)).rejects.toThrow(
      new ConflictException(
        'Tenés 2 turnos pendientes. Cancelalos antes de dar de baja la cuenta.',
      ),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(admin.auth.admin.updateUserById).not.toHaveBeenCalled();
    // Cuentan los turnos futuros, del lado que sea.
    expect(prisma.appointment.count).toHaveBeenCalledWith({
      where: {
        OR: [{ patient_id: USER }, { professional_id: USER }],
        status: { in: ['RESERVADO_SIN_PAGAR', 'CONFIRMADO'] },
        scheduled_at: { gt: NOW },
      },
    });
  });

  it('anonimiza el perfil en vez de borrarlo', async () => {
    await service.deleteMyAccount(USER, TOKEN, NOW);

    expect(prisma.profile.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: {
        email: emailDeBaja(USER),
        deleted_at: NOW,
        email_reminders: false,
        mfa_enabled: false,
      },
    });
    expect(emailDeBaja(USER)).toBe(`baja+${USER}@mediconnect.invalid`);
  });

  it('paciente: borra contacto y datos de emergencia, conserva lo que identifica su HC', async () => {
    await service.deleteMyAccount(USER, TOKEN, NOW);

    const { data } = prisma.patient.updateMany.mock.calls[0][0];
    expect(data).toEqual(
      expect.objectContaining({ phone: null, address: null, blood_type: null }),
    );
    // Nombre, apellido, DNI y nacimiento no se tocan: la HC se conserva 10 años.
    expect(data).not.toHaveProperty('first_name');
    expect(data).not.toHaveProperty('last_name');
    expect(data).not.toHaveProperty('dni');
    expect(data).not.toHaveProperty('birth_date');
  });

  it('paciente: el MediPass deja de abrir', async () => {
    await service.deleteMyAccount(USER, TOKEN, NOW);

    expect(prisma.mediPassCode.updateMany).toHaveBeenCalledWith({
      where: { patient_id: USER, expires_at: { gt: NOW } },
      data: { expires_at: NOW },
    });
    expect(prisma.mediPassEmergencyCard.updateMany).toHaveBeenCalledWith({
      where: { patient_id: USER, revoked_at: null },
      data: { revoked_at: NOW },
    });
    expect(prisma.mediPassSession.updateMany).toHaveBeenCalled();
  });

  it('paciente: borra sus reseñas y retira sus documentos, y borra los archivos después', async () => {
    await service.deleteMyAccount(USER, TOKEN, NOW);

    expect(prisma.review.deleteMany).toHaveBeenCalledWith({
      where: { patient_id: USER },
    });
    expect(prisma.patientDocument.updateMany).toHaveBeenCalledWith({
      where: { patient_id: USER, withdrawn_at: null },
      data: { withdrawn_at: NOW },
    });
    expect(remove).toHaveBeenCalledWith([`${USER}/a.pdf`]);
  });

  it('borra avisos in-app y dispositivos, pero no las filas de email', async () => {
    await service.deleteMyAccount(USER, TOKEN, NOW);

    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { user_id: USER, channel: { not: 'EMAIL' } },
    });
    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { user_id: USER },
    });
  });

  it('profesional: sale del catálogo y se queda sin agenda', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      role: 'PROFESIONAL',
      deleted_at: null,
    });

    await service.deleteMyAccount(USER, TOKEN, NOW);

    const { data } = prisma.professional.updateMany.mock.calls[0][0];
    expect(data).toEqual(
      expect.objectContaining({
        status: 'SUSPENDIDO',
        bio: null,
        photo_url: null,
      }),
    );
    // Nombre y matrícula se quedan: firman las entradas de HC que asentó.
    expect(data).not.toHaveProperty('license_number');
    expect(prisma.scheduleRule.deleteMany).toHaveBeenCalled();
    expect(prisma.scheduleBlock.deleteMany).toHaveBeenCalled();
    expect(prisma.patient.updateMany).not.toHaveBeenCalled();
  });

  it('deja constancia en audit_logs dentro de la misma transacción', async () => {
    await service.deleteMyAccount(USER, TOKEN, NOW);

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor_id: USER,
        action: 'ARCO_ACCOUNT_DELETED',
        metadata: { role: 'PACIENTE' },
      }),
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('cierra el acceso en Supabase: bloqueado, email cambiado y sin sesiones', async () => {
    await service.deleteMyAccount(USER, TOKEN, NOW);

    expect(admin.auth.admin.updateUserById).toHaveBeenCalledWith(USER, {
      email: emailDeBaja(USER),
      email_confirm: true,
      ban_duration: '876000h',
      user_metadata: {},
    });
    expect(admin.auth.admin.signOut).toHaveBeenCalledWith(TOKEN, 'global');
  });

  it('primero la base y después Supabase', async () => {
    await service.deleteMyAccount(USER, TOKEN, NOW);

    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      admin.auth.admin.updateUserById.mock.invocationCallOrder[0],
    );
  });

  it('si Supabase falla, avisa con 500 para que se reintente', async () => {
    admin.auth.admin.updateUserById.mockResolvedValue({
      error: { message: 'caído' },
    });

    await expect(service.deleteMyAccount(USER, TOKEN, NOW)).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('el reintento con la base ya suprimida solo cierra el acceso', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      role: 'PACIENTE',
      deleted_at: new Date('2026-11-04T11:00:00.000Z'),
    });

    await service.deleteMyAccount(USER, TOKEN, NOW);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.appointment.count).not.toHaveBeenCalled();
    expect(admin.auth.admin.updateUserById).toHaveBeenCalled();
  });

  it('si no se pueden borrar los archivos, la baja igual termina', async () => {
    remove.mockResolvedValue({ error: { message: 'storage caído' } });

    await expect(
      service.deleteMyAccount(USER, TOKEN, NOW),
    ).resolves.toBeUndefined();
  });
});
