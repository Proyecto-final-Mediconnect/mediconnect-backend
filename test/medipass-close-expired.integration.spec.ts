import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma';
import { MediPassService } from '../src/medipass/medipass.service';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Cierre de accesos vencidos al MediPass (ENG-104), contra Postgres de verdad.
 *
 * El cierre es un `UPDATE` en SQL crudo (`closed_at = least(coalesce(
 * revoked_at, expires_at), expires_at)`): un mock no puede probar que la condición y el valor sean los
 * que Postgres entiende. Acá se siembran sesiones en los cuatro estados y se
 * mira qué quedó en la base. El UPDATE es global (toca cualquier sesión abierta
 * de la tabla), así que los tests miran solo las filas que sembraron y nunca el
 * conteo devuelto.
 */
describe('Cierre de accesos vencidos al MediPass (integration)', () => {
  const prisma = new PrismaClient();
  const service = new MediPassService(prisma as unknown as PrismaService);
  const PATIENT = randomUUID();
  let codeId: string;

  async function sesion(
    expiresAt: Date,
    revokedAt: Date | null = null,
  ): Promise<string> {
    const s = await prisma.mediPassSession.create({
      data: {
        patient_id: PATIENT,
        medipass_code_id: codeId,
        consultant_name: 'Dra. Prueba',
        expires_at: expiresAt,
        revoked_at: revokedAt,
      },
      select: { id: true },
    });
    return s.id;
  }

  const closedAt = async (id: string) =>
    (
      await prisma.mediPassSession.findUniqueOrThrow({
        where: { id },
        select: { closed_at: true },
      })
    ).closed_at;

  beforeAll(async () => {
    await prisma.profile.create({
      data: {
        id: PATIENT,
        email: `paciente-${PATIENT}@test.local`,
        role: 'PACIENTE',
      },
    });
    await prisma.patient.create({
      data: {
        profile_id: PATIENT,
        first_name: 'Test',
        last_name: 'CloseExpired',
      },
    });
    const code = await prisma.mediPassCode.create({
      data: {
        patient_id: PATIENT,
        code: 'ZXCVBNM2',
        expires_at: new Date(Date.now() + 300_000),
      },
      select: { id: true },
    });
    codeId = code.id;
  });

  afterAll(async () => {
    await prisma.mediPassSession.deleteMany({ where: { patient_id: PATIENT } });
    await prisma.mediPassCode.deleteMany({ where: { patient_id: PATIENT } });
    await prisma.patient.deleteMany({ where: { profile_id: PATIENT } });
    await prisma.profile.deleteMany({ where: { id: PATIENT } });
    await prisma.$disconnect();
  });

  it('cierra la vencida con su vencimiento y la cortada con su corte, y deja la vigente', async () => {
    const ahora = new Date();
    const vencio = new Date(ahora.getTime() - 60_000);
    const cortada = new Date(ahora.getTime() - 120_000);

    const vencida = await sesion(vencio);
    const revocada = await sesion(new Date(ahora.getTime() + 600_000), cortada);
    const vigente = await sesion(new Date(ahora.getTime() + 600_000));

    await service.closeExpiredSessions(ahora);

    expect(await closedAt(vencida)).toEqual(vencio);
    expect(await closedAt(revocada)).toEqual(cortada);
    expect(await closedAt(vigente)).toBeNull();
  });

  it('es idempotente: la segunda corrida no vuelve a tocar las cerradas', async () => {
    const ahora = new Date();
    const vencio = new Date(ahora.getTime() - 30_000);
    const id = await sesion(vencio);
    await service.closeExpiredSessions(ahora);
    const primero = await closedAt(id);

    await service.closeExpiredSessions(ahora);

    expect(primero).toEqual(vencio);
    expect(await closedAt(id)).toEqual(primero);
  });

  it('si el corte es posterior al vencimiento, closed_at no pasa de expires_at', async () => {
    const ahora = new Date();
    const vencio = new Date(ahora.getTime() - 120_000);
    const id = await sesion(vencio, new Date(ahora.getTime() - 60_000));

    await service.closeExpiredSessions(ahora);

    expect(await closedAt(id)).toEqual(vencio);
  });
});
