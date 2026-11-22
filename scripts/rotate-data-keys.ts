// ENG-216 — Rota la clave maestra: re-envuelve las claves de datos (DEK) de los
// pacientes con la clave maestra activa (la última de DATA_ENCRYPTION_KEYS).
//
// Los datos clínicos NO se tocan: siguen cifrados con la misma DEK de cada
// paciente. Por eso se puede rotar sin violar la regla append-only de la HC, y la
// cadena de hash no cambia.
//
// Procedimiento:
//   1. `pnpm run keys:generate k2` y agregar la nueva AL FINAL de la variable en
//      Render y en el secret de GitHub: DATA_ENCRYPTION_KEYS=k1:<...>,k2:<...>
//      Desde ese deploy, las DEK nuevas se envuelven con k2 y las viejas se
//      siguen abriendo con k1.
//   2. Dry run (no escribe nada):
//        node --env-file=.env --import tsx scripts/rotate-data-keys.ts
//   3. Si da OK, aplicar:
//        node --env-file=.env --import tsx scripts/rotate-data-keys.ts --apply
//   4. Cuando el dry run diga "0 por rotar", sacar k1 de la variable.
//
// Cada fila se actualiza con un UPDATE condicionado al `kid` viejo: si el backend
// u otra corrida la cambió en el medio, no se pisa. Es idempotente: correrlo dos
// veces no hace nada la segunda. Nunca imprime una clave.

import { PrismaService } from '../src/prisma/prisma.service';
import {
  dataKeyAad,
  open,
  parseKeyring,
  seal,
} from '../src/common/crypto/data-encryption';

const APPLY = process.argv.includes('--apply');
const BATCH = 200;

async function main(): Promise<number> {
  const keyring = parseKeyring(process.env.DATA_ENCRYPTION_KEYS);
  if (!keyring) {
    console.error('MAL Falta DATA_ENCRYPTION_KEYS.');
    return 1;
  }
  const active = keyring.activeKid;
  const activeKey = keyring.keys.get(active)!;
  const prisma = new PrismaService();

  try {
    const pending = await prisma.patientDataKey.groupBy({
      by: ['kid'],
      where: { kid: { not: active } },
      _count: { _all: true },
    });
    const missing = pending.filter((p) => !keyring.keys.has(p.kid));
    if (missing.length > 0) {
      console.error(
        `MAL Hay claves de datos envueltas con ${missing.map((m) => m.kid).join(', ')}, que no está en DATA_ENCRYPTION_KEYS. Agregala antes de rotar.`,
      );
      return 1;
    }

    const total = pending.reduce((n, p) => n + p._count._all, 0);
    console.log(`Clave maestra activa: ${active}`);
    console.log(
      `Por rotar: ${total}${pending.length ? ` (${pending.map((p) => `${p.kid}: ${p._count._all}`).join(', ')})` : ''}`,
    );
    if (total === 0) {
      console.log(
        'OK Nada para rotar. Ya se pueden sacar las claves viejas de la variable.',
      );
      return 0;
    }

    let rotated = 0;
    let skipped = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma.patientDataKey.findMany({
        where: { kid: { not: active } },
        orderBy: { patient_id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { patient_id: cursor }, skip: 1 } : {}),
        select: { patient_id: true, kid: true, wrapped_dek: true },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].patient_id;

      for (const row of rows) {
        // Abrir con la vieja prueba que la fila está sana antes de reescribirla.
        const dek = open(
          keyring.keys.get(row.kid)!,
          row.wrapped_dek,
          dataKeyAad(row.patient_id, row.kid),
        );
        if (!APPLY) {
          rotated += 1;
          continue;
        }
        const { count } = await prisma.patientDataKey.updateMany({
          where: { patient_id: row.patient_id, kid: row.kid },
          data: {
            kid: active,
            wrapped_dek: seal(
              activeKey,
              dek,
              dataKeyAad(row.patient_id, active),
            ),
            rotated_at: new Date(),
          },
        });
        if (count === 1) rotated += 1;
        else skipped += 1;
      }
    }

    if (APPLY) {
      console.log(
        `OK Rotadas: ${rotated}. Cambiadas por otro proceso en el medio: ${skipped}.`,
      );
    } else {
      console.log(
        `DRY RUN: se rotarían ${rotated}. Todas abren con su clave actual. Para aplicar: --apply`,
      );
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Sin el stack completo: no hay claves en los mensajes, pero tampoco hace
    // falta más que el motivo.
    console.error(`MAL ${(error as Error).name}: ${(error as Error).message}`);
    process.exitCode = 1;
  });
