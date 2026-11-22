import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';
import { AdminService } from '../src/admin/admin.service';
import type { ProfessionalAccountNoticesService } from '../src/notifications/professional-account-notices.service';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * La validación de matrículas (ENG-192) contra Postgres de verdad: lo que un
 * mock no prueba es que el `updateMany` condicionado al estado sea el árbitro
 * cuando dos administradores deciden a la vez, y que la cola lea la decisión y
 * el motivo de `audit_logs`.
 */
describe('Matrículas desde el panel del administrador (integration)', () => {
  const prisma = new PrismaClient();
  const licenseDecided = jest.fn().mockResolvedValue(undefined);
  const service = new AdminService(
    prisma as unknown as PrismaService,
    {
      licenseDecided,
    } as unknown as ProfessionalAccountNoticesService,
  );

  const adminId: string = randomUUID();
  const aValidar: string = randomUUID();
  const aRechazar: string = randomUUID();
  const profiles = [adminId, aValidar, aRechazar];

  beforeAll(async () => {
    await prisma.profile.createMany({
      data: [
        {
          id: adminId,
          email: `admin-${adminId}@test.local`,
          role: 'ADMINISTRADOR',
        },
        {
          id: aValidar,
          email: `pro-${aValidar}@test.local`,
          role: 'PROFESIONAL',
        },
        {
          id: aRechazar,
          email: `pro-${aRechazar}@test.local`,
          role: 'PROFESIONAL',
        },
      ],
    });
    for (const [id, apellido] of [
      [aValidar, 'Validable'],
      [aRechazar, 'Rechazable'],
    ]) {
      await prisma.professional.create({
        data: {
          profile_id: id,
          first_name: 'Test',
          last_name: apellido,
          license_number: `MP-${id.slice(0, 8)}`,
        },
      });
    }
  });

  afterAll(async () => {
    // En la base de tests `audit_logs` no tiene el trigger append-only (vive en
    // las migraciones), así que se puede limpiar.
    await prisma.auditLog.deleteMany({ where: { actor_id: adminId } });
    await prisma.professional.deleteMany({
      where: { profile_id: { in: [aValidar, aRechazar] } },
    });
    await prisma.profile.deleteMany({ where: { id: { in: profiles } } });
    await prisma.$disconnect();
  });

  it('los dos pendientes están en la cola, del más viejo al más nuevo', async () => {
    const cola = await service.licenseQueue('PENDIENTE_VALIDACION_MATRICULA');
    const nuestros = cola.filter((p) => [aValidar, aRechazar].includes(p.id));
    expect(nuestros.map((p) => p.id)).toEqual([aValidar, aRechazar]);
    expect(nuestros[0]).toMatchObject({
      email: `pro-${aValidar}@test.local`,
      decision: null,
    });
  });

  it('si dos administradores validan a la vez, gana uno y el otro recibe 409', async () => {
    const resultados = await Promise.allSettled([
      service.decideLicense(adminId, aValidar, { decision: 'VALIDADO' }),
      service.decideLicense(adminId, aValidar, { decision: 'VALIDADO' }),
    ]);

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rechazado = resultados.find((r) => r.status === 'rejected');
    expect((rechazado as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );

    const pro = await prisma.professional.findUniqueOrThrow({
      where: { profile_id: aValidar },
      select: { status: true },
    });
    expect(pro.status).toBe('VALIDADO');
    // Una sola decisión auditada, con el origen.
    const logs = await prisma.auditLog.findMany({
      where: {
        resource_id: aValidar,
        action: 'PROFESSIONAL_LICENSE_VALIDATED',
      },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toMatchObject({ origin: 'ADMINISTRADOR' });
    expect(licenseDecided).toHaveBeenCalledTimes(1);
  });

  it('el rechazo deja el motivo, que la cola de rechazados lee de la auditoría', async () => {
    await service.decideLicense(adminId, aRechazar, {
      decision: 'RECHAZADO',
      reason: '  La matrícula no figura en el registro provincial.  ',
    });

    const rechazados = await service.licenseQueue('RECHAZADO');
    const item = rechazados.find((p) => p.id === aRechazar);
    expect(item?.status).toBe('RECHAZADO');
    expect(item?.decision?.reason).toBe(
      'La matrícula no figura en el registro provincial.',
    );

    const validados = await service.licenseQueue('VALIDADO');
    expect(validados.find((p) => p.id === aValidar)?.decision).toMatchObject({
      reason: null,
    });
  });
});
