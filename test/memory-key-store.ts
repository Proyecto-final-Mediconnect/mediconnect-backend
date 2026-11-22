import { randomBytes } from 'node:crypto';
import { ClinicalDataCipher } from '../src/common/crypto/clinical-data-cipher';
import { parseKeyring } from '../src/common/crypto/data-encryption';
import type { PrismaService } from '../src/prisma/prisma.service';

interface KeyRow {
  patient_id: string;
  kid: string;
  wrapped_dek: string;
}

/**
 * Un `ClinicalDataCipher` prendido, con `patient_data_keys` en memoria y una
 * clave maestra al azar. Para los specs que prueban algo cifrado sin base.
 */
export function encryptingCipher(): ClinicalDataCipher {
  const rows = new Map<string, KeyRow>();
  const store = {
    patientDataKey: {
      findUnique: ({ where }: { where: { patient_id: string } }) =>
        Promise.resolve(rows.get(where.patient_id) ?? null),
      createMany: ({ data }: { data: KeyRow[] }) => {
        for (const row of data) {
          if (!rows.has(row.patient_id)) rows.set(row.patient_id, row);
        }
        return Promise.resolve({ count: data.length });
      },
    },
  } as unknown as PrismaService;
  return new ClinicalDataCipher(
    store,
    parseKeyring(`k1:${randomBytes(32).toString('base64')}`),
  );
}
