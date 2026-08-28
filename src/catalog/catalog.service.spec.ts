import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from './catalog.service';
import { ListProfessionalsQueryDto } from './dto/list-professionals-query.dto';

type FindManyArgs = Prisma.ProfessionalFindManyArgs;

/** Fila cruda como la devuelve Prisma con el `select` del catálogo. */
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    profile_id: '11111111-1111-4111-8111-111111111111',
    first_name: 'Ana',
    last_name: 'Álvarez',
    photo_url: 'https://cdn.test/ana.jpg',
    consultation_price: new Prisma.Decimal('12000.50'),
    currency: 'ARS',
    specialties: [
      { specialty: { id: 'spec-cardio', name: 'Cardiología' } },
      { specialty: { id: 'spec-clinica', name: 'Clínica Médica' } },
    ],
    ...overrides,
  };
}

function query(overrides: Partial<ListProfessionalsQueryDto> = {}) {
  return Object.assign(new ListProfessionalsQueryDto(), overrides);
}

describe('CatalogService', () => {
  let service: CatalogService;
  const findMany = jest.fn();
  const count = jest.fn();

  beforeEach(async () => {
    findMany.mockReset().mockResolvedValue([]);
    count.mockReset().mockResolvedValue(0);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogService,
        {
          provide: PrismaService,
          useValue: {
            professional: { findMany, count },
            // El service envuelve findMany + count en $transaction para que
            // ambos vean el mismo snapshot; el mock resuelve las promesas que
            // ya se ejecutaron al armarse el array.
            $transaction: (promises: Promise<unknown>[]) =>
              Promise.all(promises),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(CatalogService);
  });

  describe('listProfessionals — recorte de lo público', () => {
    it('expone únicamente profesionales VALIDADO', async () => {
      await service.listProfessionals(query());

      const args = findMany.mock.calls[0][0] as FindManyArgs;
      expect(args.where).toMatchObject({ status: 'VALIDADO' });
      expect((count.mock.calls[0][0] as FindManyArgs).where).toMatchObject({
        status: 'VALIDADO',
      });
    });

    it('no puede pedirse otro status desde el query (el filtro es fijo)', async () => {
      // Aun si un cliente inyectara `status`, el DTO lo descarta y el service
      // lo pisa: la tarjeta de un profesional pendiente nunca es pública.
      await service.listProfessionals(
        query({ status: 'PENDIENTE_VALIDACION_MATRICULA' } as never),
      );

      const args = findMany.mock.calls[0][0] as FindManyArgs;
      expect(args.where).toMatchObject({ status: 'VALIDADO' });
    });

    it('no selecciona campos privados del profesional', async () => {
      await service.listProfessionals(query());

      const select = (findMany.mock.calls[0][0] as FindManyArgs).select ?? {};
      expect(select).not.toHaveProperty('license_number');
      expect(select).not.toHaveProperty('mercadopago_account_id');
      expect(select).not.toHaveProperty('bio');
    });
  });

  describe('listProfessionals — paginación', () => {
    it('pide 20 por página por defecto y arranca en la primera', async () => {
      await service.listProfessionals(query());

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('traduce page a offset', async () => {
      await service.listProfessionals(query({ page: 3, limit: 20 }));

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 20 }),
      );
    });

    it('ordena con un criterio total para que el offset no repita filas', async () => {
      await service.listProfessionals(query());

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { last_name: 'asc' },
            { first_name: 'asc' },
            { profile_id: 'asc' },
          ],
        }),
      );
    });

    it('marca hasNextPage mientras queden páginas', async () => {
      count.mockResolvedValue(45);
      findMany.mockResolvedValue([row()]);

      const result = await service.listProfessionals(query({ page: 2 }));

      expect(result.meta).toEqual({
        page: 2,
        limit: 20,
        total: 45,
        totalPages: 3,
        hasNextPage: true,
      });
    });

    it('apaga hasNextPage en la última página', async () => {
      count.mockResolvedValue(45);

      const result = await service.listProfessionals(query({ page: 3 }));

      expect(result.meta.hasNextPage).toBe(false);
    });

    it('sin resultados devuelve lista vacía y total 0 (no un error)', async () => {
      count.mockResolvedValue(0);
      findMany.mockResolvedValue([]);

      const result = await service.listProfessionals(
        query({ specialtyId: '22222222-2222-4222-8222-222222222222' }),
      );

      expect(result.data).toEqual([]);
      expect(result.meta).toMatchObject({
        total: 0,
        totalPages: 0,
        hasNextPage: false,
      });
    });
  });

  describe('listProfessionals — filtros', () => {
    it('filtra por especialidad vía la junction', async () => {
      const specialtyId = '33333333-3333-4333-8333-333333333333';

      await service.listProfessionals(query({ specialtyId }));

      expect((findMany.mock.calls[0][0] as FindManyArgs).where).toMatchObject({
        specialties: { some: { specialty_id: specialtyId } },
      });
    });

    it('aplica el rango de precio completo', async () => {
      await service.listProfessionals(
        query({ minPrice: 5000, maxPrice: 9000 }),
      );

      expect((findMany.mock.calls[0][0] as FindManyArgs).where).toMatchObject({
        consultation_price: { gte: 5000, lte: 9000 },
      });
    });

    it('acepta un extremo suelto del rango', async () => {
      await service.listProfessionals(query({ minPrice: 5000 }));

      const where = (findMany.mock.calls[0][0] as FindManyArgs).where;
      expect(where?.consultation_price).toEqual({ gte: 5000 });
    });

    it('no toca consultation_price si no hay filtro de precio', async () => {
      await service.listProfessionals(query());

      const where = (findMany.mock.calls[0][0] as FindManyArgs).where;
      expect(where).not.toHaveProperty('consultation_price');
    });

    it('combina especialidad y precio en el mismo where', async () => {
      const specialtyId = '44444444-4444-4444-8444-444444444444';

      await service.listProfessionals(
        query({ specialtyId, minPrice: 1000, maxPrice: 2000 }),
      );

      expect((findMany.mock.calls[0][0] as FindManyArgs).where).toMatchObject({
        status: 'VALIDADO',
        specialties: { some: { specialty_id: specialtyId } },
        consultation_price: { gte: 1000, lte: 2000 },
      });
    });

    it('usa el mismo where para contar que para listar', async () => {
      await service.listProfessionals(query({ minPrice: 1000 }));

      expect((count.mock.calls[0][0] as FindManyArgs).where).toEqual(
        (findMany.mock.calls[0][0] as FindManyArgs).where,
      );
    });
  });

  describe('listProfessionals — forma de la tarjeta', () => {
    it('mapea foto, nombre, precio y especialidad principal', async () => {
      findMany.mockResolvedValue([row()]);
      count.mockResolvedValue(1);

      const [card] = (await service.listProfessionals(query())).data;

      expect(card).toEqual({
        id: '11111111-1111-4111-8111-111111111111',
        firstName: 'Ana',
        lastName: 'Álvarez',
        photoUrl: 'https://cdn.test/ana.jpg',
        primarySpecialty: { id: 'spec-cardio', name: 'Cardiología' },
        specialties: [
          { id: 'spec-cardio', name: 'Cardiología' },
          { id: 'spec-clinica', name: 'Clínica Médica' },
        ],
        price: 12000.5,
        currency: 'ARS',
      });
    });

    it('serializa el precio como número, no como Decimal', async () => {
      findMany.mockResolvedValue([row()]);
      count.mockResolvedValue(1);

      const [card] = (await service.listProfessionals(query())).data;

      expect(typeof card.price).toBe('number');
      expect(JSON.parse(JSON.stringify(card)).price).toBe(12000.5);
    });

    it('tolera un profesional sin foto, sin precio y sin especialidad', async () => {
      findMany.mockResolvedValue([
        row({ photo_url: null, consultation_price: null, specialties: [] }),
      ]);
      count.mockResolvedValue(1);

      const [card] = (await service.listProfessionals(query())).data;

      expect(card).toMatchObject({
        photoUrl: null,
        price: null,
        primarySpecialty: null,
        specialties: [],
      });
    });

    it('pide las especialidades ordenadas por nombre (define la principal)', async () => {
      await service.listProfessionals(query());

      const select = (findMany.mock.calls[0][0] as FindManyArgs).select;
      expect(select).toMatchObject({
        specialties: { orderBy: { specialty: { name: 'asc' } } },
      });
    });
  });
});
