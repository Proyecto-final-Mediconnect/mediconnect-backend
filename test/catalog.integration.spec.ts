import { PrismaClient, Prisma } from '../generated/prisma';
import { CatalogService } from '../src/catalog/catalog.service';
import { ListProfessionalsQueryDto } from '../src/catalog/dto/list-professionals-query.dto';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * ENG-49 contra PostgreSQL real: lo que los unit tests no pueden afirmar —
 * que el ORDER BY + OFFSET pagina sin repetir ni saltear filas, que el filtro
 * por especialidad resuelve bien la junction N:M, y que un precio nullable no
 * entra en un rango.
 */
describe('Catálogo público (integration)', () => {
  const prisma = new PrismaClient();
  const service = new CatalogService(prisma as unknown as PrismaService);

  // Nombres pensados para ejercitar el orden: dos homónimos de apellido
  // (Álvarez) y un acento, que en collation C ordenaría distinto que en es_AR.
  const seed = [
    { last: 'Álvarez', first: 'Ana', price: '8000.00', specs: ['Cardiología'] },
    {
      last: 'Álvarez',
      first: 'Bruno',
      price: '15000.00',
      specs: ['Pediatría'],
    },
    {
      last: 'Benítez',
      first: 'Carla',
      price: '5000.00',
      specs: ['Cardiología', 'Clínica Médica'],
    },
    {
      last: 'Cabrera',
      first: 'Diego',
      price: '22000.00',
      specs: ['Clínica Médica'],
    },
    { last: 'Duarte', first: 'Elena', price: null, specs: ['Pediatría'] },
  ];

  let specialtyIds: Record<string, string>;
  /** IDs de los validados, en el orden en que el catálogo debe devolverlos. */
  let expectedOrder: string[];

  function query(overrides: Partial<ListProfessionalsQueryDto> = {}) {
    return Object.assign(new ListProfessionalsQueryDto(), overrides);
  }

  async function createProfessional(opts: {
    email: string;
    first: string;
    last: string;
    price: string | null;
    status: 'VALIDADO' | 'PENDIENTE_VALIDACION_MATRICULA' | 'SUSPENDIDO';
    specs: string[];
  }): Promise<string> {
    const profile = await prisma.profile.create({
      data: {
        id: crypto.randomUUID(),
        email: opts.email,
        role: 'PROFESIONAL',
        professional: {
          create: {
            first_name: opts.first,
            last_name: opts.last,
            license_number: 'MP-TEST',
            photo_url: `https://cdn.test/${opts.first.toLowerCase()}.jpg`,
            consultation_price:
              opts.price === null ? null : new Prisma.Decimal(opts.price),
            status: opts.status,
            specialties: {
              create: opts.specs.map((name) => ({
                specialty_id: specialtyIds[name],
              })),
            },
          },
        },
      },
    });
    return profile.id;
  }

  beforeAll(async () => {
    // Base limpia: la suite corre contra mediconnect_test, que `prisma db
    // push` recrea, pero igual se aísla de corridas previas.
    await prisma.professionalSpecialty.deleteMany();
    await prisma.professional.deleteMany();
    await prisma.profile.deleteMany();

    const names = ['Cardiología', 'Clínica Médica', 'Pediatría'];
    for (const name of names) {
      await prisma.specialty.upsert({
        where: { name },
        update: {},
        create: { name },
      });
    }
    const specialties = await prisma.specialty.findMany({
      where: { name: { in: names } },
    });
    specialtyIds = Object.fromEntries(specialties.map((s) => [s.name, s.id]));

    expectedOrder = [];
    for (const p of seed) {
      expectedOrder.push(
        await createProfessional({
          email: `${p.first.toLowerCase()}.${p.last.toLowerCase()}@test.com`,
          first: p.first,
          last: p.last,
          price: p.price,
          status: 'VALIDADO',
          specs: p.specs,
        }),
      );
    }

    // Ruido que NO debe aparecer nunca en el catálogo público.
    await createProfessional({
      email: 'pendiente@test.com',
      first: 'Ana',
      last: 'Aaaaa',
      price: '1000.00',
      status: 'PENDIENTE_VALIDACION_MATRICULA',
      specs: ['Cardiología'],
    });
    await createProfessional({
      email: 'suspendido@test.com',
      first: 'Bruno',
      last: 'Aaaaa',
      price: '1000.00',
      status: 'SUSPENDIDO',
      specs: ['Cardiología'],
    });
  });

  afterAll(async () => {
    await prisma.professionalSpecialty.deleteMany();
    await prisma.professional.deleteMany();
    await prisma.profile.deleteMany();
    await prisma.$disconnect();
  });

  it('lista solo profesionales con la matrícula validada', async () => {
    const result = await service.listProfessionals(query({ limit: 50 }));

    expect(result.meta.total).toBe(seed.length);
    expect(result.data.map((c) => c.lastName)).not.toContain('Aaaaa');
  });

  it('ordena por apellido y nombre', async () => {
    const result = await service.listProfessionals(query({ limit: 50 }));

    expect(result.data.map((c) => `${c.lastName} ${c.firstName}`)).toEqual([
      'Álvarez Ana',
      'Álvarez Bruno',
      'Benítez Carla',
      'Cabrera Diego',
      'Duarte Elena',
    ]);
  });

  it('pagina sin repetir ni saltear filas al recorrer todas las páginas', async () => {
    const collected: string[] = [];
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      const result = await service.listProfessionals(query({ page, limit: 2 }));
      collected.push(...result.data.map((c) => c.id));
      hasNextPage = result.meta.hasNextPage;
      page += 1;
      expect(page).toBeLessThan(10); // corta un bucle infinito si algo falla
    }

    expect(collected).toEqual(expectedOrder);
    expect(new Set(collected).size).toBe(expectedOrder.length);
  });

  it('reporta total y totalPages sobre el conjunto filtrado, no sobre la página', async () => {
    const result = await service.listProfessionals(
      query({ page: 1, limit: 2 }),
    );

    expect(result.data).toHaveLength(2);
    expect(result.meta).toMatchObject({
      total: 5,
      totalPages: 3,
      hasNextPage: true,
    });
  });

  it('una página más allá del final devuelve vacío en vez de error', async () => {
    const result = await service.listProfessionals(query({ page: 99 }));

    expect(result.data).toEqual([]);
    expect(result.meta.hasNextPage).toBe(false);
  });

  it('filtra por especialidad resolviendo la junction N:M', async () => {
    const result = await service.listProfessionals(
      query({ specialtyId: specialtyIds['Cardiología'], limit: 50 }),
    );

    expect(result.data.map((c) => c.firstName)).toEqual(['Ana', 'Carla']);
    expect(result.meta.total).toBe(2);
  });

  it('devuelve todas las especialidades del profesional y la principal alfabética', async () => {
    const result = await service.listProfessionals(
      query({ specialtyId: specialtyIds['Clínica Médica'], limit: 50 }),
    );

    const carla = result.data.find((c) => c.firstName === 'Carla');
    expect(carla?.specialties.map((s) => s.name)).toEqual([
      'Cardiología',
      'Clínica Médica',
    ]);
    expect(carla?.primarySpecialty?.name).toBe('Cardiología');
  });

  it('filtra por rango de precio (extremos incluidos)', async () => {
    const result = await service.listProfessionals(
      query({ minPrice: 5000, maxPrice: 15000, limit: 50 }),
    );

    expect(
      result.data.map((c) => c.price).sort((a, b) => Number(a) - Number(b)),
    ).toEqual([5000, 8000, 15000]);
  });

  it('excluye al profesional sin precio cargado cuando hay filtro de precio', async () => {
    const conFiltro = await service.listProfessionals(
      query({ minPrice: 0, limit: 50 }),
    );
    const sinFiltro = await service.listProfessionals(query({ limit: 50 }));

    expect(conFiltro.data.map((c) => c.firstName)).not.toContain('Elena');
    expect(sinFiltro.data.map((c) => c.firstName)).toContain('Elena');
    expect(
      sinFiltro.data.find((c) => c.firstName === 'Elena')?.price,
    ).toBeNull();
  });

  it('combina especialidad y precio', async () => {
    const result = await service.listProfessionals(
      query({
        specialtyId: specialtyIds['Cardiología'],
        maxPrice: 6000,
        limit: 50,
      }),
    );

    expect(result.data.map((c) => c.firstName)).toEqual(['Carla']);
  });

  it('un filtro sin coincidencias devuelve una lista vacía, no un error', async () => {
    const result = await service.listProfessionals(
      query({ minPrice: 900000, limit: 50 }),
    );

    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
  });

  it('no expone campos privados del profesional en la tarjeta', async () => {
    const [card] = (await service.listProfessionals(query())).data;

    expect(Object.keys(card).sort()).toEqual([
      'currency',
      'firstName',
      'id',
      'lastName',
      'photoUrl',
      'price',
      'primarySpecialty',
      'specialties',
    ]);
  });

  it('serializa el precio como número JSON, no como Decimal', async () => {
    const [card] = (await service.listProfessionals(query())).data;

    expect(JSON.parse(JSON.stringify(card)).price).toBe(8000);
  });
});
