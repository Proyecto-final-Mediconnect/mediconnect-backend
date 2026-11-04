// ENG-49 — Métricas del catálogo público.
//
// Siembra N profesionales validados en una base descartable, mide la latencia
// del listado (p50/p95) para los escenarios reales del scroll infinito y
// verifica con EXPLAIN ANALYZE que los índices de la migración
// 20260812000000_eng49_catalog_indexes se estén usando.
//
// Ejecutar (contra la BD de tests, NO contra Supabase):
//   pnpm run metrics:catalog
//
// Borra y recrea los datos de prueba que crea (emails @metrics.test).

import { PrismaClient, Prisma } from '../generated/prisma';
import { CatalogService } from '../src/catalog/catalog.service';
import { ListProfessionalsQueryDto } from '../src/catalog/dto/list-professionals-query.dto';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ReviewsService } from '../src/reviews/reviews.service';

// 20k filas: con unos cientos el planner elige seq scan aunque el índice
// exista (la tabla entra en pocas páginas), y el EXPLAIN no diría nada sobre
// cómo escala el catálogo.
const TOTAL_PROFESSIONALS = Number(process.env.METRICS_ROWS ?? 20_000);
const ITERATIONS = Number(process.env.METRICS_ITERATIONS ?? 30);
const EMAIL_DOMAIN = 'metrics.test';

/**
 * Uno de cada `PENDING_EVERY` queda sin validar.
 *
 * Es constante y no un número suelto porque el porcentaje que informa el script
 * se calcula desde acá: hasta ENG-185 el mensaje decía "80 % validados" mientras
 * el código hacía 1 de cada 7 (85,7 %), y las dos líneas habían entrado juntas.
 * Cambiar este número ahora cambia el mensaje solo.
 */
const PENDING_EVERY = 7;

/** Porcentaje de sembrados que queda `VALIDADO`, derivado de `PENDING_EVERY`. */
const VALIDATED_PCT = (100 * (PENDING_EVERY - 1)) / PENDING_EVERY;

const prisma = new PrismaClient();
const service = new CatalogService(
  prisma as unknown as PrismaService,
  new ReviewsService(prisma as unknown as PrismaService),
);

const SPECIALTIES = [
  'Cardiología',
  'Clínica Médica',
  'Pediatría',
  'Dermatología',
  'Neurología',
];

function query(overrides: Partial<ListProfessionalsQueryDto>) {
  return Object.assign(new ListProfessionalsQueryDto(), overrides);
}

function percentile(sorted: number[], p: number): number {
  // Nearest-rank: con 30 muestras el p95 es la 29ª, no una interpolación.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

async function cleanup(): Promise<void> {
  await prisma.professionalSpecialty.deleteMany({
    where: { professional: { profile: { email: { endsWith: EMAIL_DOMAIN } } } },
  });
  await prisma.professional.deleteMany({
    where: { profile: { email: { endsWith: EMAIL_DOMAIN } } },
  });
  await prisma.profile.deleteMany({
    where: { email: { endsWith: EMAIL_DOMAIN } },
  });
}

async function seed(): Promise<Record<string, string>> {
  for (const name of SPECIALTIES) {
    await prisma.specialty.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  const rows = await prisma.specialty.findMany({
    where: { name: { in: SPECIALTIES } },
  });
  const specialtyIds = Object.fromEntries(rows.map((s) => [s.name, s.id]));

  const profiles: Prisma.ProfileCreateManyInput[] = [];
  const professionals: Prisma.ProfessionalCreateManyInput[] = [];
  const links: Prisma.ProfessionalSpecialtyCreateManyInput[] = [];

  for (let i = 0; i < TOTAL_PROFESSIONALS; i++) {
    const id = crypto.randomUUID();
    // 1 de cada `PENDING_EVERY` queda sin validar: el catálogo debe
    // descartarlos, y así el filtro por status no es trivialmente "toda la
    // tabla". 7 es coprimo con los 5 valores de especialidad, para que
    // "pendiente" no se concentre en una especialidad y la deje vacía.
    const status =
      i % PENDING_EVERY === 0 ? 'PENDIENTE_VALIDACION_MATRICULA' : 'VALIDADO';

    profiles.push({
      id,
      email: `pro-${i}@${EMAIL_DOMAIN}`,
      role: 'PROFESIONAL',
    });
    professionals.push({
      profile_id: id,
      first_name: `Nombre${String(i).padStart(5, '0')}`,
      last_name: `Apellido${String(i % 997).padStart(3, '0')}`,
      license_number: `MP-${i}`,
      consultation_price: new Prisma.Decimal(2000 + (i % 40) * 750),
      status,
    });
    links.push({
      professional_id: id,
      specialty_id: specialtyIds[SPECIALTIES[i % SPECIALTIES.length]],
    });
  }

  // createMany en lotes: 20k filas en un solo INSERT arma una sentencia con
  // cientos de miles de parámetros y el driver la rechaza.
  const CHUNK = 2_000;
  for (let i = 0; i < profiles.length; i += CHUNK) {
    await prisma.profile.createMany({ data: profiles.slice(i, i + CHUNK) });
  }
  for (let i = 0; i < professionals.length; i += CHUNK) {
    await prisma.professional.createMany({
      data: professionals.slice(i, i + CHUNK),
    });
  }
  for (let i = 0; i < links.length; i += CHUNK) {
    await prisma.professionalSpecialty.createMany({
      data: links.slice(i, i + CHUNK),
    });
  }

  // Sin ANALYZE, el planner trabaja con estadísticas vacías y elige seq scan
  // aunque el índice exista — el EXPLAIN de abajo mediría otra cosa.
  await prisma.$executeRawUnsafe(
    'analyze public.professionals, public.professional_specialties',
  );

  return specialtyIds;
}

async function measure(
  label: string,
  args: Partial<ListProfessionalsQueryDto>,
): Promise<void> {
  // Descarta el primer hit: incluye el parseo/preparación del statement.
  await service.listProfessionals(query(args));

  const samples: number[] = [];
  let total = 0;
  let returned = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const result = await service.listProfessionals(query(args));
    samples.push(performance.now() - start);
    total = result.meta.total;
    returned = result.data.length;
  }

  samples.sort((a, b) => a - b);
  const avg = samples.reduce((s, n) => s + n, 0) / samples.length;

  console.log(
    `${label.padEnd(34)} p50 ${percentile(samples, 50).toFixed(1).padStart(6)} ms` +
      ` | p95 ${percentile(samples, 95).toFixed(1).padStart(6)} ms` +
      ` | avg ${avg.toFixed(1).padStart(6)} ms` +
      ` | ${String(returned).padStart(2)}/${total} filas`,
  );
}

async function explain(
  label: string,
  sql: string,
  params: unknown[],
): Promise<void> {
  const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
    `explain (analyze, buffers) ${sql}`,
    ...params,
  );
  const lines = plan.map((r) => r['QUERY PLAN']);
  const relevant = lines
    .map((l) => l.trim())
    .filter((l) => /Scan|Sort Method|Execution Time/.test(l));

  console.log(`\n${label}`);
  for (const line of relevant) console.log(`  ${line}`);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (/supabase|pooler/.test(url)) {
    throw new Error(
      `Estas métricas siembran ${TOTAL_PROFESSIONALS} profesionales y los borran al terminar: ` +
        'apuntá DATABASE_URL a la BD de tests (localhost:5433), no a Supabase.',
    );
  }

  console.log(`\nENG-49 — métricas del catálogo público`);
  console.log(
    `Sembrando ${TOTAL_PROFESSIONALS} profesionales ` +
      `(${VALIDATED_PCT.toFixed(1)} % validados)…`,
  );
  await cleanup();
  const specialtyIds = await seed();

  // Filtrado por el dominio de prueba, igual que `cleanup()`. Sin el filtro
  // cuenta todos los validados de la base —el seed de demo, lo que hayan dejado
  // otros specs— y el número no cierra con el "Sembrando" de la línea de arriba.
  const validated = await prisma.professional.count({
    where: {
      status: 'VALIDADO',
      profile: { email: { endsWith: EMAIL_DOMAIN } },
    },
  });
  console.log(`Listos: ${validated} validados sembrados en el catálogo.\n`);

  console.log(`Latencia del service (${ITERATIONS} corridas por escenario)\n`);
  await measure('página 1 (sin filtros)', { page: 1, limit: 20 });
  await measure('página 10 (scroll infinito)', { page: 10, limit: 20 });
  await measure('página 100 (offset profundo)', { page: 100, limit: 20 });
  await measure('filtro por especialidad', {
    page: 1,
    limit: 20,
    specialtyId: [specialtyIds['Cardiología']],
  });
  await measure('filtro por rango de precio', {
    page: 1,
    limit: 20,
    minPrice: 5000,
    maxPrice: 15000,
  });
  await measure('especialidad + precio', {
    page: 1,
    limit: 20,
    specialtyId: [specialtyIds['Cardiología']],
    minPrice: 5000,
    maxPrice: 15000,
  });

  // El filtro múltiple es el caso nuevo: `in` sobre la junction en vez de una
  // igualdad. Se mide aparte para poder compararlo contra el de una sola.
  await measure('filtro por tres especialidades', {
    page: 1,
    limit: 20,
    specialtyId: [
      specialtyIds['Cardiología'],
      specialtyIds['Clínica Médica'],
      specialtyIds['Pediatría'],
    ],
  });
  await measure('filtro sin resultados', {
    page: 1,
    limit: 20,
    minPrice: 999999,
  });

  console.log('\n\nPlanes de ejecución (índices de ENG-49)');
  await explain(
    'Listado paginado — ORDER BY apellido, nombre, id',
    `select profile_id from public.professionals
       where status = 'VALIDADO'
       order by last_name asc, first_name asc, profile_id asc
       limit 20 offset 1980`,
    [],
  );
  await explain(
    'Filtro por rango de precio',
    `select profile_id from public.professionals
       where status = 'VALIDADO' and consultation_price between 5000 and 15000`,
    [],
  );
  await explain(
    'Filtro por especialidad (junction)',
    `select professional_id from public.professional_specialties where specialty_id = $1::uuid`,
    [specialtyIds['Cardiología']],
  );

  console.log('\nListo.\n');
}

/**
 * Borra los datos sembrados, pase lo que pase.
 *
 * Va en el `finally` y no al final de `main()`: si una medición o un `EXPLAIN`
 * fallan —o alguien corta con Ctrl-C— los 20.000 profesionales se quedan en la
 * base. Y esa base **es la misma que usan los tests de integración**
 * (`localhost:5433`, ver `scripts/test-integration.sh`), así que una corrida
 * fallida acá deja la suite rota para el que venga después, con un síntoma que
 * no apunta al catálogo.
 *
 * Si la limpieza falla, se reporta aparte y **no reemplaza** al error original:
 * el que importa para saber qué pasó es el primero, y perderlo detrás de un
 * fallo de limpieza es justo lo que haría difícil el diagnóstico.
 */
async function limpiar(): Promise<void> {
  try {
    console.log('\nLimpiando datos de prueba…');
    await cleanup();
  } catch (e: unknown) {
    console.error(
      `⚠️  No se pudieron borrar los datos de prueba. Quedaron filas @${EMAIL_DOMAIN} ` +
        'en la base y pueden romper los tests de integración. Borralas a mano:',
      e,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((e: unknown) => {
    console.error('❌ Métricas fallaron:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await limpiar();
    await prisma.$disconnect();
  });
