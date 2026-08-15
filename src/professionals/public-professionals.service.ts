import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

/** Especialidad tal como se expone en el perfil público. */
export type PublicSpecialtyView = {
  id: string;
  name: string;
};

/** Formación (título) del profesional en el perfil público. */
export type PublicEducationView = {
  id: string;
  institution: string;
  degree: string;
  /** `null` cuando el profesional no cargó el año del título. */
  year: number | null;
};

/**
 * Perfil público de UN profesional (ENG-50): todos los datos públicos para que
 * un paciente evalúe si reservar. Contrato explícito de campos seguros — NO
 * incluye matrícula, `status`, cuenta de MercadoPago ni timestamps internos.
 */
export type PublicProfessionalProfileView = {
  id: string;
  firstName: string;
  lastName: string;
  photoUrl: string | null;
  bio: string | null;
  specialties: PublicSpecialtyView[];
  education: PublicEducationView[];
  /** `null` si el profesional todavía no cargó su precio de consulta. */
  price: number | null;
  currency: string;
};

/**
 * Solo los profesionales con la matrícula validada son públicos. Un perfil
 * PENDIENTE/RECHAZADO/SUSPENDIDO responde 404 (no se filtra su existencia).
 */
const PUBLIC_STATUS = 'VALIDADO' as const;

/** Campos que viajan al perfil público. `select` explícito para no exponer
 *  `license_number`, `mercadopago_account_id` ni internos por accidente. */
const PUBLIC_SELECT = {
  profile_id: true,
  first_name: true,
  last_name: true,
  bio: true,
  photo_url: true,
  consultation_price: true,
  currency: true,
  specialties: {
    select: { specialty: { select: { id: true, name: true } } },
    orderBy: { specialty: { name: 'asc' } },
  },
  education: {
    select: { id: true, institution: true, degree: true, year: true },
    // Más reciente primero; los títulos sin año cargado van al final.
    orderBy: [
      { year: { sort: 'desc', nulls: 'last' } },
      { institution: 'asc' },
    ],
  },
} satisfies Prisma.ProfessionalSelect;

type ProfessionalRow = Prisma.ProfessionalGetPayload<{
  select: typeof PUBLIC_SELECT;
}>;

@Injectable()
export class PublicProfessionalsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Devuelve el perfil público del profesional `id` (= `profiles.id`). Lee con
   * Prisma filtrando por `status = VALIDADO`: el rol y los datos salen de la
   * base, no del cliente. 404 si no existe o no está validado.
   */
  async getPublicProfile(id: string): Promise<PublicProfessionalProfileView> {
    const row = await this.prisma.professional.findFirst({
      where: { profile_id: id, status: PUBLIC_STATUS },
      select: PUBLIC_SELECT,
    });

    if (!row) {
      throw new NotFoundException('No se encontró el profesional.');
    }

    return toPublicView(row);
  }
}

function toPublicView(row: ProfessionalRow): PublicProfessionalProfileView {
  return {
    id: row.profile_id,
    firstName: row.first_name,
    lastName: row.last_name,
    photoUrl: row.photo_url,
    bio: row.bio,
    specialties: row.specialties.map((link) => link.specialty),
    education: row.education.map((e) => ({
      id: e.id,
      institution: e.institution,
      degree: e.degree,
      year: e.year,
    })),
    // Prisma devuelve Decimal: sin este cast el JSON sale como `{ s, e, d }`.
    price:
      row.consultation_price === null ? null : Number(row.consultation_price),
    currency: row.currency,
  };
}
