// ENG-240 — Le da el rol ADMINISTRADOR a una cuenta existente.
//
// Nadie se registra como administrador: `handle_new_user` degrada a PACIENTE
// cualquier rol que no sea PACIENTE o PROFESIONAL. El rol se asigna con este
// script, a mano y con el OK de quien administra la base:
//
//   1. La persona se registra en la web como paciente, con el mail que va a
//      usar para administrar, y **no completa** el perfil de paciente.
//   2. Dry run (no escribe nada; termina en ROLLBACK):
//        node --env-file=.env --import tsx scripts/grant-admin.ts <email>
//   3. Si el dry run da OK, se aplica:
//        node --env-file=.env --import tsx scripts/grant-admin.ts <email> --apply
//
// Solo acepta una cuenta PACIENTE recién creada: sin fila en `patients`, sin
// turnos y sin historia clínica. Convertir a un paciente real dejaría sus datos
// colgados de una cuenta que ya no es de paciente, y un profesional perdería su
// catálogo y su agenda.
//
// El trigger `prevent_profile_role_change` bloquea cualquier cambio de rol (es
// la defensa contra la escalada por PostgREST, ENG-37). El script lo apaga y lo
// vuelve a prender **dentro de la misma transacción**: si algo falla, el
// ROLLBACK deshace las dos cosas y el trigger queda prendido. Necesita correr
// con el dueño de la tabla (el usuario de `DATABASE_URL`).
//
// Queda en `audit_logs` como `ADMIN_ROLE_GRANTED`, con origen DATA_FIX.

import { PrismaClient } from '../generated/prisma/client';

const [email] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');

class Rollback extends Error {}

function fail(message: string): never {
  console.error(`MAL ${message}`);
  throw new Error(message);
}

async function main() {
  if (!email) {
    console.error('Uso: scripts/grant-admin.ts <email> [--apply]');
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient();
  console.log(
    APPLY ? '*** APLICANDO ***' : '--- DRY RUN (rollback al final) ---',
  );
  try {
    await prisma.$transaction(async (tx) => {
      const profile = await tx.profile.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: {
          id: true,
          email: true,
          role: true,
          deleted_at: true,
          patient: { select: { profile_id: true } },
        },
      });
      if (!profile) fail(`No hay ninguna cuenta con el mail ${email}.`);
      if (profile.deleted_at) fail('La cuenta está dada de baja.');
      if (profile.role === 'ADMINISTRADOR') fail('Ya es administrador.');
      if (profile.role !== 'PACIENTE') {
        fail(
          `Es ${profile.role}: solo se convierte una cuenta de paciente nueva.`,
        );
      }
      if (profile.patient) {
        fail('Completó el perfil de paciente: tiene datos de paciente.');
      }
      const turnos = await tx.appointment.count({
        where: { patient_id: profile.id },
      });
      if (turnos > 0) fail(`Tiene ${turnos} turnos: es un paciente real.`);
      console.log(
        `OK  cuenta ${profile.email} (${profile.id}), PACIENTE nueva`,
      );

      await tx.$executeRawUnsafe(
        'alter table public.profiles disable trigger profiles_prevent_role_change',
      );
      const updated = await tx.profile.updateMany({
        where: { id: profile.id, role: 'PACIENTE' },
        data: { role: 'ADMINISTRADOR' },
      });
      await tx.$executeRawUnsafe(
        'alter table public.profiles enable trigger profiles_prevent_role_change',
      );
      if (updated.count !== 1) fail(`Se actualizaron ${updated.count} filas.`);

      await tx.auditLog.create({
        data: {
          actor_id: null,
          action: 'ADMIN_ROLE_GRANTED',
          resource_type: 'profiles',
          resource_id: profile.id,
          metadata: {
            ticket: 'ENG-240',
            origin: 'DATA_FIX',
            previousRole: 'PACIENTE',
          },
        },
      });

      const after = await tx.profile.findUniqueOrThrow({
        where: { id: profile.id },
        select: { role: true },
      });
      console.log(`OK  rol nuevo: ${after.role}`);
      if (!APPLY) throw new Rollback();
    });
    console.log('*** APLICADO ***');
  } catch (error) {
    if (error instanceof Rollback) {
      console.log('--- DRY RUN OK: nada se escribió ---');
    } else {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
