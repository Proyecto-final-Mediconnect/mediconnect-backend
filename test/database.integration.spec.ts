import { PrismaClient } from '../generated/prisma';

describe('Database connectivity (integration)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('connects to the real PostgreSQL instance and runs a query', async () => {
    const result = await prisma.$queryRaw<{ result: number }[]>`SELECT 1 as result`;

    expect(result[0].result).toBe(1);
  });
});
