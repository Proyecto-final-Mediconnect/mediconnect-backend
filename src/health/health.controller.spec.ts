import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { DB_CHECK_TIMEOUT_MS, HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  const prisma = { $queryRaw: jest.fn() };

  beforeEach(async () => {
    jest.useRealTimers();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma.$queryRaw.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('devuelve ok cuando la base responde', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const report = await controller.check();

    expect(report).toMatchObject({ status: 'ok', db: 'ok' });
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
  });

  it('devuelve 503 cuando la base falla', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

    await expect(controller.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('no filtra el mensaje de Postgres en la respuesta', async () => {
    prisma.$queryRaw.mockRejectedValue(
      new Error('password authentication failed for user "postgres"'),
    );

    const error = (await controller
      .check()
      .catch((e: unknown) => e)) as ServiceUnavailableException;

    expect(error.getResponse()).toEqual({
      status: 'error',
      db: 'down',
      timestamp: expect.any(String),
    });
  });

  it('devuelve 503 cuando la base no contesta a tiempo', async () => {
    jest.useFakeTimers();
    prisma.$queryRaw.mockReturnValue(new Promise(() => {}));

    const pending = controller.check();
    jest.advanceTimersByTime(DB_CHECK_TIMEOUT_MS + 1);

    await expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
