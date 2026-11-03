import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../generated/prisma';
import {
  AccountDeletionService,
  emailDeBaja,
} from '../src/privacy/account-deletion.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SupabaseService } from '../src/supabase/supabase.service';

/**
 * La baja de una cuenta (ENG-86, derecho de supresión) contra Postgres de verdad.
 *
 * Lo que un mock no puede probar: que la transacción pase por los triggers
 * append-only de las tablas sensibles (`patient_documents` solo deja marcar el
 * retiro, `legal_acceptances` no deja tocar nada), que los `jsonb` queden
 * vacíos de verdad y no con el valor JSON `null`, y que lo que la ley obliga a
 * conservar siga ahí después.
 */
/**
 * `db push` no crea los triggers: viven solo en las migraciones. Se instalan
 * desde el SQL real las funciones y los triggers append-only de las dos tablas
 * que la baja toca y no puede borrar, para que la transacción pase por ellos
 * igual que en producción.
 */
const MIGRACIONES_CON_TRIGGERS = [
  '20261013130000_eng140_legal_acceptances',
  '20261102120000_eng164_patient_documents',
];

async function instalarTriggers(prisma: PrismaClient): Promise<void> {
  for (const carpeta of MIGRACIONES_CON_TRIGGERS) {
    const sql = readFileSync(
      join(__dirname, '..', 'prisma', 'migrations', carpeta, 'migration.sql'),
      'utf8',
    );
    for (const bloque of sql.split(/^--;;[ \t]*\r?$/m)) {
      const sentencia = bloque
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim();
      if (
        /^(create or replace function|drop trigger|create trigger)/i.test(
          sentencia,
        )
      ) {
        await prisma.$executeRawUnsafe(sentencia);
      }
    }
  }
}

describe('Baja de la cuenta (integration)', () => {
  const prisma = new PrismaClient();
  const remove = jest.fn().mockResolvedValue({ error: null });
  const admin = {
    auth: {
      admin: {
        updateUserById: jest.fn().mockResolvedValue({ error: null }),
        signOut: jest.fn().mockResolvedValue({ error: null }),
      },
    },
    storage: { from: () => ({ remove }) },
  };
  const service = new AccountDeletionService(
    prisma as unknown as PrismaService,
    { getServiceClient: () => admin } as unknown as SupabaseService,
  );

  const PATIENT = randomUUID();
  const PRO = randomUUID();
  let appointmentId: string;

  beforeAll(async () => {
    await instalarTriggers(prisma);
    await prisma.profile.createMany({
      data: [
        { id: PATIENT, email: `p-${PATIENT}@test.local`, role: 'PACIENTE' },
        { id: PRO, email: `pro-${PRO}@test.local`, role: 'PROFESIONAL' },
      ],
    });
    await prisma.patient.create({
      data: {
        profile_id: PATIENT,
        first_name: 'Marina',
        last_name: 'Ocampo',
        dni: PATIENT.slice(0, 8),
        phone: '1155550000',
        address: 'Calle Falsa 123',
        blood_type: '0+',
        allergies: [{ que: 'Penicilina', gravedad: 'Anafilaxia' }],
        emergency_contact: {
          nombre: 'Ana',
          vinculo: 'Hermana',
          telefono: '11',
        },
      },
    });
    await prisma.professional.create({
      data: {
        profile_id: PRO,
        first_name: 'Pablo',
        last_name: 'Rivas',
        license_number: `MP-${PRO.slice(0, 8)}`,
        bio: 'Clínico',
        status: 'VALIDADO',
      },
    });
    await prisma.legalAcceptance.create({
      data: { profile_id: PATIENT, version: 'it-1', source: 'REGISTER' },
    });
    const appt = await prisma.appointment.create({
      data: {
        patient_id: PATIENT,
        professional_id: PRO,
        scheduled_at: new Date(Date.now() - 7 * 24 * 3600_000),
        duration_minutes: 30,
        price: 10000,
        status: 'COMPLETADO',
      },
    });
    appointmentId = appt.id;
    await prisma.review.create({
      data: {
        patient_id: PATIENT,
        professional_id: PRO,
        appointment_id: appt.id,
        rating: 5,
        comment: 'Excelente',
      },
    });
    await prisma.patientDocument.create({
      data: {
        patient_id: PATIENT,
        type: 'ESTUDIO',
        title: 'Análisis',
        storage_path: `${PATIENT}/${randomUUID()}.pdf`,
        sha256: 'a'.repeat(64),
        mime_type: 'application/pdf',
        size_bytes: 100,
      },
    });
    await prisma.mediPassCode.create({
      data: {
        patient_id: PATIENT,
        code:
          'IT' +
          PATIENT.replace(/[^2-9]/g, '')
            .slice(0, 6)
            .padEnd(6, '2'),
        expires_at: new Date(Date.now() + 5 * 60_000),
      },
    });
  });

  afterAll(async () => {
    // Igual que las suites de ENG-140 y ENG-164: se bajan los triggers para
    // dejar la base limpia y no trabar a las que corren después (el catálogo
    // borra todos los perfiles). Lo que importaba ya se probó con ellos activos.
    for (const sql of [
      'drop trigger if exists legal_acceptances_no_truncate on public.legal_acceptances',
      'drop trigger if exists legal_acceptances_no_mutation on public.legal_acceptances',
      'drop trigger if exists patient_documents_no_truncate on public.patient_documents',
      'drop trigger if exists patient_documents_no_mutation on public.patient_documents',
      // Por si la suite de ENG-87 ya los dejó instalados en otra corrida.
      'drop trigger if exists audit_logs_no_mutation on public.audit_logs',
      'drop trigger if exists audit_logs_no_truncate on public.audit_logs',
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    const ids = [PATIENT, PRO];
    await prisma.mediPassSession.deleteMany({ where: { patient_id: PATIENT } });
    await prisma.mediPassCode.deleteMany({ where: { patient_id: PATIENT } });
    await prisma.patientDocument.deleteMany({ where: { patient_id: PATIENT } });
    await prisma.appointment.deleteMany({
      where: { OR: [{ patient_id: PATIENT }, { professional_id: PRO }] },
    });
    await prisma.auditLog.deleteMany({ where: { actor_id: { in: ids } } });
    await prisma.legalAcceptance.deleteMany({
      where: { profile_id: { in: ids } },
    });
    await prisma.patient.deleteMany({ where: { profile_id: PATIENT } });
    await prisma.professional.deleteMany({ where: { profile_id: PRO } });
    await prisma.profile.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('los triggers append-only están activos (si no, el resto no prueba nada)', async () => {
    await expect(
      prisma.legalAcceptance.updateMany({
        where: { profile_id: PATIENT },
        data: { version: 'otra' },
      }),
    ).rejects.toThrow(/append-only|42501/);
  });

  it('con un turno pendiente no da de baja y no toca nada', async () => {
    const pendiente = await prisma.appointment.create({
      data: {
        patient_id: PATIENT,
        professional_id: PRO,
        scheduled_at: new Date(Date.now() + 48 * 3600_000),
        duration_minutes: 30,
        price: 10000,
        status: 'CONFIRMADO',
      },
    });

    await expect(service.deleteMyAccount(PATIENT, 'tok')).rejects.toThrow(
      /turno pendiente/,
    );
    const profile = await prisma.profile.findUnique({ where: { id: PATIENT } });
    expect(profile?.deleted_at).toBeNull();

    await prisma.appointment.delete({ where: { id: pendiente.id } });
  });

  it('suprime lo que puede y conserva lo que la ley obliga', async () => {
    await service.deleteMyAccount(PATIENT, 'tok');

    const profile = await prisma.profile.findUnique({ where: { id: PATIENT } });
    expect(profile?.email).toBe(emailDeBaja(PATIENT));
    expect(profile?.deleted_at).not.toBeNull();

    const patient = await prisma.patient.findUnique({
      where: { profile_id: PATIENT },
    });
    // Se conserva: identifica la historia clínica (Ley 26.529 art. 18).
    expect(patient?.first_name).toBe('Marina');
    expect(patient?.dni).toBe(PATIENT.slice(0, 8));
    // Se suprime: contacto y datos de emergencia, con los jsonb vacíos de verdad.
    expect(patient?.phone).toBeNull();
    expect(patient?.address).toBeNull();
    expect(patient?.blood_type).toBeNull();
    const [jsonb] = await prisma.$queryRawUnsafe<
      { allergies: unknown; contacto: unknown }[]
    >(
      `select allergies is null as allergies, emergency_contact is null as contacto
       from patients where profile_id = $1::uuid`,
      PATIENT,
    );
    expect(jsonb).toEqual({ allergies: true, contacto: true });

    // La constancia de consentimiento sigue (append-only).
    expect(
      await prisma.legalAcceptance.count({ where: { profile_id: PATIENT } }),
    ).toBe(1);
    // El turno pasado sigue: es un registro de la atención.
    expect(
      await prisma.appointment.count({ where: { id: appointmentId } }),
    ).toBe(1);

    // La reseña se borró, el documento quedó retirado y el código vencido.
    expect(await prisma.review.count({ where: { patient_id: PATIENT } })).toBe(
      0,
    );
    const doc = await prisma.patientDocument.findFirst({
      where: { patient_id: PATIENT },
    });
    expect(doc?.withdrawn_at).not.toBeNull();
    expect(
      await prisma.mediPassCode.count({
        where: { patient_id: PATIENT, expires_at: { gt: new Date() } },
      }),
    ).toBe(0);

    expect(
      await prisma.auditLog.count({
        where: { actor_id: PATIENT, action: 'ARCO_ACCOUNT_DELETED' },
      }),
    ).toBe(1);
    expect(remove).toHaveBeenCalledWith([doc?.storage_path]);
  });

  it('pedirla de nuevo no vuelve a suprimir: solo reintenta cerrar el acceso', async () => {
    admin.auth.admin.updateUserById.mockClear();

    await service.deleteMyAccount(PATIENT, 'tok');

    expect(
      await prisma.auditLog.count({
        where: { actor_id: PATIENT, action: 'ARCO_ACCOUNT_DELETED' },
      }),
    ).toBe(1);
    expect(admin.auth.admin.updateUserById).toHaveBeenCalledTimes(1);
  });

  it('un profesional sale del catálogo y se queda con nombre y matrícula', async () => {
    await prisma.scheduleRule.create({
      data: {
        professional_id: PRO,
        weekday: 1,
        start_time: new Date('1970-01-01T09:00:00.000Z'),
        end_time: new Date('1970-01-01T12:00:00.000Z'),
        slot_duration_minutes: 30,
      },
    });

    await service.deleteMyAccount(PRO, 'tok');

    const pro = await prisma.professional.findUnique({
      where: { profile_id: PRO },
    });
    expect(pro?.status).toBe('SUSPENDIDO');
    expect(pro?.bio).toBeNull();
    expect(pro?.license_number).toBe(`MP-${PRO.slice(0, 8)}`);
    expect(
      await prisma.scheduleRule.count({ where: { professional_id: PRO } }),
    ).toBe(0);
  });
});
