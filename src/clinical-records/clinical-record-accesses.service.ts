import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Cuántos accesos por página. Mismo tamaño que el historial del MediPass. */
const PAGE_SIZE = 10;

/** Un acceso de un profesional a la historia clínica del paciente. */
export interface ClinicalRecordAccess {
  id: string;
  /** `null` si la cuenta del profesional ya no tiene perfil (se borró). */
  profesional: {
    nombre: string;
    especialidad: string | null;
    matricula: string;
  } | null;
  /** ISO-8601. */
  el: string;
}

export interface ClinicalRecordAccessPage {
  accesos: ClinicalRecordAccess[];
  pagina: number;
  hayMas: boolean;
}

/**
 * Quién abrió la historia clínica del paciente (HU, ENG-165).
 *
 * Lee `audit_logs`, que ya registra cada lectura de la HC (ENG-87, inmutable).
 * Es el equivalente para la HC del historial del MediPass (ENG-76).
 *
 * ## Las lecturas del propio paciente no se muestran
 *
 * Lo que el paciente quiere saber es quién **más** la abrió. Sus propias
 * lecturas son una por cada vez que entra a la pantalla: listarlas taparía,
 * justo, los accesos de terceros que esta lista existe para mostrar.
 *
 * ## Aislamiento
 *
 * El filtro es `resource_id = id del JWT`: el recurso auditado de una lectura es
 * la HC del paciente, y la HC es del paciente. No hay parámetro de ruta con un
 * id, así que no hay forma de pedir los accesos de otro.
 */
@Injectable()
export class ClinicalRecordAccessesService {
  constructor(private readonly prisma: PrismaService) {}

  async listMyAccesses(
    patientId: string,
    pagina: number,
  ): Promise<ClinicalRecordAccessPage> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        action: 'CLINICAL_RECORD_READ',
        resource_type: 'clinical_record_entries',
        resource_id: patientId,
        NOT: { actor_id: patientId },
      },
      orderBy: { created_at: 'desc' },
      skip: (pagina - 1) * PAGE_SIZE,
      take: PAGE_SIZE + 1,
      select: {
        id: true,
        created_at: true,
        actor: {
          select: {
            professional: {
              select: {
                first_name: true,
                last_name: true,
                license_number: true,
                specialties: {
                  select: { specialty: { select: { name: true } } },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    return {
      accesos: rows.slice(0, PAGE_SIZE).map((row) => {
        const pro = row.actor?.professional;
        return {
          id: row.id,
          profesional: pro
            ? {
                nombre: `${pro.first_name} ${pro.last_name}`.trim(),
                especialidad: pro.specialties[0]?.specialty.name ?? null,
                matricula: pro.license_number,
              }
            : null,
          el: row.created_at.toISOString(),
        };
      }),
      pagina,
      hayMas: rows.length > PAGE_SIZE,
    };
  }
}
