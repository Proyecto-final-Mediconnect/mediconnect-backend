import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import type { ListProfessionalsQueryDto } from './dto/list-professionals-query.dto';

/** Especialidad tal como se expone en el catálogo público. */
export type SpecialtyView = {
  id: string;
  name: string;
};

/** Tarjeta del listado (ENG-49): foto, nombre, especialidad principal, precio. */
export type ProfessionalCardView = {
  id: string;
  firstName: string;
  lastName: string;
  photoUrl: string | null;
  /**
   * El modelo no marca una especialidad como principal (N:M sin flag): se
   * toma la primera alfabéticamente, que es también el orden en que se
   * devuelve `specialties`. Es estable entre requests.
   */
  primarySpecialty: SpecialtyView | null;
  specialties: SpecialtyView[];
  /** `null` si el profesional todavía no cargó su precio de consulta. */
  price: number | null;
  currency: string;
};

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
};

export type ProfessionalListView = {
  data: ProfessionalCardView[];
  meta: PaginationMeta;
};

/**
 * Solo los profesionales con la matrícula validada son públicos. Es el
 * "cuenta verificada" del criterio de aceptación de ENG-49 y el único filtro
 * que NO puede venir del cliente.
 */
const PUBLIC_STATUS = 'VALIDADO' as const;

/** Campos que viajan al catálogo público. Evita traer `license_number`,
 *  `mercadopago_account_id` y demás datos internos por accidente. */
const CARD_SELECT = {
  profile_id: true,
  first_name: true,
  last_name: true,
  photo_url: true,
  consultation_price: true,
  currency: true,
  specialties: {
    select: { specialty: { select: { id: true, name: true } } },
    orderBy: { specialty: { name: 'asc' } },
  },
} satisfies Prisma.ProfessionalSelect;

type ProfessionalRow = Prisma.ProfessionalGetPayload<{
  select: typeof CARD_SELECT;
}>;

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listProfessionals(
    query: ListProfessionalsQueryDto,
  ): Promise<ProfessionalListView> {
    const { page, limit } = query;
    const where = buildWhere(query);

    // Una sola transacción para que `total` y la página correspondan al mismo
    // snapshot: con scroll infinito, un alta entre ambas queries desplazaría
    // los resultados y el usuario vería un profesional repetido o salteado.
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.professional.findMany({
        where,
        select: CARD_SELECT,
        // El tercer criterio desempata homónimos: sin un orden total, el
        // OFFSET de la página siguiente puede repetir u omitir filas.
        orderBy: [
          { last_name: 'asc' },
          { first_name: 'asc' },
          { profile_id: 'asc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.professional.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      data: rows.map(toCardView),
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
      },
    };
  }
}

function buildWhere(
  query: ListProfessionalsQueryDto,
): Prisma.ProfessionalWhereInput {
  const { specialtyId, minPrice, maxPrice } = query;

  const where: Prisma.ProfessionalWhereInput = { status: PUBLIC_STATUS };

  if (specialtyId) {
    where.specialties = { some: { specialty_id: specialtyId } };
  }

  // `consultation_price` es nullable: al filtrar por rango, un profesional sin
  // precio cargado queda afuera (no se puede afirmar que entre en el rango),
  // pero sigue apareciendo cuando no hay filtro de precio.
  if (minPrice !== undefined || maxPrice !== undefined) {
    where.consultation_price = {
      ...(minPrice !== undefined && { gte: minPrice }),
      ...(maxPrice !== undefined && { lte: maxPrice }),
    };
  }

  return where;
}

function toCardView(row: ProfessionalRow): ProfessionalCardView {
  const specialties = row.specialties.map((link) => link.specialty);

  return {
    id: row.profile_id,
    firstName: row.first_name,
    lastName: row.last_name,
    photoUrl: row.photo_url,
    primarySpecialty: specialties[0] ?? null,
    specialties,
    // Prisma devuelve Decimal: sin este cast el JSON sale como objeto
    // `{ s, e, d }` en vez de un número.
    price:
      row.consultation_price === null ? null : Number(row.consultation_price),
    currency: row.currency,
  };
}
